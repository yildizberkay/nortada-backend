import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── JSON value type ────────────────────────────────────────────────────────
// Used for every `jsonb().$type<JsonValue>()` column. Interfaces (not inline
// recursive type aliases) prevent "type instantiation excessively deep" errors.
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export interface JsonArray extends Array<JsonValue | undefined> {}
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

// ─── Shared column builders ─────────────────────────────────────────────────
// Every table carries an internal integer identity PK (`id`) plus a public,
// opaque UUID (`uid`) that is the only id surfaced through the API. Timestamps
// are `timestamptz` (UTC) — Splash is global and stores weather/session times
// in UTC (docs/otonom-kararlar.md §6). Helpers are FUNCTIONS (not shared column
// objects) so each table gets a fresh builder instance — Drizzle mutates
// builders when they are attached to a table.

/** Internal integer identity primary key. Never exposed through the API. */
export const idColumn = () =>
  integer("id").primaryKey().generatedAlwaysAsIdentity();

/** Public opaque UUID — the id used in URLs and responses. */
export const uidColumn = () =>
  text("uid").notNull().unique().default(sql`gen_random_uuid()`);

export const createdAtColumn = () =>
  timestamp("created_at", { precision: 3, withTimezone: true })
    .defaultNow()
    .notNull();

export const updatedAtColumn = () =>
  timestamp("updated_at", { precision: 3, withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date());

// ─── Shared domain enums ─────────────────────────────────────────────────────
// Vocabulary mirrored from the iOS app (Models.swift / AnalyticsModels.swift),
// stored as lowercase identifiers; display labels are client-side. `sport` is a
// cross-cutting enum reused by future domains (activity, spot, alerts).
export const sportEnum = pgEnum("sport", [
  "windsurf",
  "wingfoil",
  "sailing",
  "kitesurf",
  "sup",
  "kayak",
  "other",
]);

export const experienceLevelEnum = pgEnum("experience_level", [
  "beginner",
  "intermediate",
  "advanced",
  "racing",
]);

export const mainGoalEnum = pgEnum("main_goal", [
  "find_days",
  "track_sessions",
  "improve_speed",
  "improve_technique",
  "consistency",
  "racing",
  "explore",
]);

export const analyticsFocusEnum = pgEnum("analytics_focus", [
  "balanced",
  "speed",
  "endurance",
  "technique",
  "racing",
  "custom",
]);

export const windUnitEnum = pgEnum("wind_unit", ["kt", "ms", "kmh", "mph"]);
export const distanceUnitEnum = pgEnum("distance_unit", ["km", "mi", "nm"]);
export const temperatureUnitEnum = pgEnum("temperature_unit", ["c", "f"]);

export const summaryMetricEnum = pgEnum("summary_metric", [
  "distance",
  "time_on_water",
  "moving_time",
  "max_speed",
  "avg_speed",
  "best_10s",
  "best_5x10",
  "avg_pace",
  "best_vmg",
  "sessions",
  "active_days",
]);

export const activityPeriodEnum = pgEnum("activity_period", [
  "week",
  "month",
  "season",
  "year",
  "custom",
]);

// ─── auth (RFC-0002) ─────────────────────────────────────────────────────────
// One row per identity. Anonymous devices and real Clerk logins live in the
// same table so `c.var.user` is uniform. On login the anonymous row is either
// upgraded in place (no pre-existing Clerk row) or soft-merged into the existing
// Clerk row (`mergedIntoUserId`), never hard-deleted (audit + graceful reject of
// the old anonymous token).
export const userTable = pgTable(
  "user",
  {
    id: idColumn(),
    uid: uidColumn(),
    // Null for anonymous users. Unique among non-null (partial index below).
    clerkUserId: text("clerk_user_id"),
    isAnonymous: boolean("is_anonymous").notNull().default(true),
    // The device-scoped id from the app Keychain that owns this anonymous row.
    anonymousDeviceId: text("anonymous_device_id"),
    email: text("email"),
    displayName: text("display_name"),
    // Set when THIS anonymous row was merged into another (Clerk) user on login.
    // A non-null value means the row is retired — its tokens must be rejected.
    mergedIntoUserId: integer("merged_into_user_id").references(
      (): AnyPgColumn => userTable.id,
    ),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("user_clerk_user_id_key")
      .on(t.clerkUserId)
      .where(sql`${t.clerkUserId} IS NOT NULL`),
    uniqueIndex("user_anonymous_device_id_key")
      .on(t.anonymousDeviceId)
      .where(sql`${t.anonymousDeviceId} IS NOT NULL`),
    index("user_merged_into_user_id_idx").on(t.mergedIntoUserId),
  ],
);

export type User = typeof userTable.$inferSelect;
export type NewUser = typeof userTable.$inferInsert;

// ─── user profile (RFC-0003) ─────────────────────────────────────────────────
// Global, app-wide personalization — one row per user. Values are preferences
// only; canonical API values stay SI and unit conversion is client-side (D-006).
export const userProfileTable = pgTable("user_profile", {
  id: idColumn(),
  uid: uidColumn(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => userTable.id),
  primarySport: sportEnum("primary_sport").notNull(),
  sports: sportEnum("sports").array().notNull(),
  experience: experienceLevelEnum("experience").notNull(),
  goal: mainGoalEnum("goal").notNull(),
  focus: analyticsFocusEnum("focus").notNull(),
  // Remembered Activity filter — null means "All Sports".
  activityFilter: sportEnum("activity_filter"),
  // The primary sport's summary-card metrics (per-sport overrides live in
  // user_sport_profile).
  cardSlots: summaryMetricEnum("card_slots").array().notNull(),
  defaultActivityPeriod: activityPeriodEnum(
    "default_activity_period",
  ).notNull(),
  windUnit: windUnitEnum("wind_unit").notNull(),
  distanceUnit: distanceUnitEnum("distance_unit").notNull(),
  temperatureUnit: temperatureUnitEnum("temperature_unit").notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export type UserProfile = typeof userProfileTable.$inferSelect;
export type NewUserProfile = typeof userProfileTable.$inferInsert;

// Per-sport override of the personalization defaults — optional rows, one per
// (user, sport). Layout fields (enabled sections / timeline layers) land with
// the activity dashboard vocabulary in RFC-0006. Thresholds are canonical SI
// (m/s). `prefs` is an open jsonb bag for forward-compatible per-sport settings.
export const userSportProfileTable = pgTable(
  "user_sport_profile",
  {
    id: idColumn(),
    uid: uidColumn(),
    userId: integer("user_id")
      .notNull()
      .references(() => userTable.id),
    sport: sportEnum("sport").notNull(),
    // Null → fall back to the derived defaults for this sport.
    cardSlots: summaryMetricEnum("card_slots").array(),
    // Speed thresholds in canonical SI metres-per-second (Mps, NOT milliseconds).
    planingThresholdMps: real("planing_threshold_mps"),
    foilingThresholdMps: real("foiling_threshold_mps"),
    prefs: jsonb("prefs").$type<JsonValue>(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("user_sport_profile_user_sport_key").on(t.userId, t.sport),
  ],
);

export type UserSportProfile = typeof userSportProfileTable.$inferSelect;
export type NewUserSportProfile = typeof userSportProfileTable.$inferInsert;

// ─── Schema registry ────────────────────────────────────────────────────────
// Every domain appends its tables / enums / relations here. Drizzle's
// `db.query.*` API is generated from this object.
export const dbSchema = {
  user: userTable,
  userProfile: userProfileTable,
  userSportProfile: userSportProfileTable,
};
