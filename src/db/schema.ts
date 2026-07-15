import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
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
  // Appended for spot sourcing (wave surfing). Enum order is not significant.
  "surfing",
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

// ─── spot enums (RFC-0004) ───────────────────────────────────────────────────
export const waterTypeEnum = pgEnum("water_type", [
  "sea",
  "lake",
  "bay",
  "river",
  "marina",
  "open_coast",
]);

export const spotSkillEnum = pgEnum("spot_skill", [
  "beginner",
  "intermediate",
  "advanced",
  "all",
]);

// 16-point compass — good/risky wind directions are stored as these; the live
// side/on/off-shore verdict is derived from `shoreBearingDeg` at query time.
export const compassDirectionEnum = pgEnum("compass_direction", [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
]);

export const spotSourceEnum = pgEnum("spot_source", [
  "osm",
  "curated",
  "user_suggested",
]);

export const spotStatusEnum = pgEnum("spot_status", [
  "published",
  "pending",
  "rejected",
]);

// Multi-valued venue type — a place can be several at once (a school on a public
// beach = [public_spot, school]). `public_spot` = freely go-able water access;
// the rest are services/POIs. Distinct from geo quality (`onWater`).
export const placeTypeEnum = pgEnum("place_type", [
  "public_spot",
  "school",
  "rental",
  "club",
  "center",
  "marina",
  "accommodation",
  "shop",
]);

// ─── weather enums (RFC-0005) ────────────────────────────────────────────────
export const weatherKindEnum = pgEnum("weather_kind", ["forecast", "marine"]);

// ─── activity enums (RFC-0006) ───────────────────────────────────────────────
export const activityStatusEnum = pgEnum("activity_status", [
  "processing", // uploaded, metrics not yet computed
  "ready", // metrics computed
  "failed", // metric computation failed
]);

// Data source — future-proofed for Apple Watch from P0 (D: "source field ready").
export const activitySourceEnum = pgEnum("activity_source", [
  "iphone",
  "watch",
  "import",
  "manual",
]);

// forecast (what the app showed) vs observed (real station/obs, later) — kept as
// SEPARATE rows so forecast-vs-reality is possible.
export const activityConditionKindEnum = pgEnum("activity_condition_kind", [
  "forecast",
  "observed",
]);

export const activityPrivacyEnum = pgEnum("activity_privacy", [
  "private",
  "followers",
  "public",
]);

// P0 best-effort types: time windows + distance windows + the 5×10 rule. Alpha /
// by-side / planing-only efforts are P1 (see activity-data-model.md §4).
export const effortTypeEnum = pgEnum("effort_type", [
  "time_2s",
  "time_5s",
  "time_10s",
  "time_20s",
  "time_30s",
  "time_1m",
  "time_5m",
  "dist_100m",
  "dist_250m",
  "dist_500m",
  "dist_1km",
  "dist_nm",
  "best_5x10",
]);

export const equipmentTypeEnum = pgEnum("equipment_type", [
  "board",
  "sail",
  "wing",
  "kite",
  "foil",
  "boat",
  "sup",
  "kayak",
  "paddle",
  "generic",
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
    // Admin/moderator flag — gates spot moderation (RFC-0004) and future admin
    // surfaces. Set out-of-band (never via the API).
    isAdmin: boolean("is_admin").notNull().default(false),
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

// Refresh tokens for our own (anonymous-device) auth. The access token is
// short-lived (~15 min JWT); this table backs the long-lived refresh + rotation.
// Tokens are stored HASHED (SHA-256) — never plaintext. `familyId` ties one
// login's rotation lineage together, so presenting an already-rotated token (a
// theft signal) can revoke the whole family (reuse detection). Clerk sessions do
// NOT use this table — Clerk manages its own token lifecycle.
export const refreshTokenTable = pgTable(
  "refresh_token",
  {
    id: idColumn(),
    uid: uidColumn(),
    userId: integer("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    // SHA-256 hash of the opaque refresh token (never the token itself).
    tokenHash: text("token_hash").notNull().unique(),
    // Rotation lineage — all rotations descending from one login share a family.
    familyId: text("family_id").notNull(),
    expiresAt: timestamp("expires_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),
    // Set when this token is rotated or revoked. A revoked token presented again
    // is a reuse/theft signal → the whole family is revoked.
    revokedAt: timestamp("revoked_at", { precision: 3, withTimezone: true }),
    // The hash that superseded this token on rotation (audit/lineage).
    replacedByHash: text("replaced_by_hash"),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index("refresh_token_user_id_idx").on(t.userId),
    index("refresh_token_family_id_idx").on(t.familyId),
    index("refresh_token_expires_at_idx").on(t.expiresAt),
  ],
);
export type RefreshToken = typeof refreshTokenTable.$inferSelect;
export type NewRefreshToken = typeof refreshTokenTable.$inferInsert;

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
    // Open jsonb bag for per-sport tuning — only some sports use each key, so a
    // flexible bag beats sparse dedicated columns. Holds e.g.
    // `planingThresholdMps` / `foilingThresholdMps` (canonical SI m/s), which
    // only windsurf/wing use.
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

// ─── spot (RFC-0004) ─────────────────────────────────────────────────────────
// Watersports spots. Geo nearby uses a `(latitude, longitude)` bbox pre-filter
// + haversine ordering — plain Postgres, no PostGIS (D-003). Coordinates are
// doublePrecision (float4 loses longitude precision). `shoreBearingDeg` is the
// core IP: wind direction → side/on/off-shore is derived from it at query time.
export const spotTable = pgTable(
  "watersport_spot",
  {
    id: idColumn(),
    uid: uidColumn(),
    name: text("name").notNull(),
    country: text("country"),
    region: text("region"),
    locality: text("locality"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    waterType: waterTypeEnum("water_type"),
    supportedSports: sportEnum("supported_sports").array().notNull(),
    skillSuitability: spotSkillEnum("skill_suitability"),
    // 0–360°, coastline-facing normal. Null until derived/curated.
    shoreBearingDeg: real("shore_bearing_deg"),
    goodWindDirections: compassDirectionEnum("good_wind_directions").array(),
    riskyWindDirections: compassDirectionEnum("risky_wind_directions").array(),
    // Free-tagged hazards ("offshore_wind", "shallows", "rocks"…) — open set,
    // so text[] rather than an enum.
    hazards: text("hazards").array(),
    source: spotSourceEnum("source").notNull(),
    // OpenStreetMap element id when sourced from OSM — dedupe + update key.
    osmId: text("osm_id"),
    status: spotStatusEnum("status").notNull().default("pending"),
    // Geo quality: is the coordinate on/at the water (vs an inland business
    // address). Populated by the attribute-derivation pass; null until computed.
    onWater: boolean("on_water"),
    // Venue-type tags — what kind of place this is (spot vs school vs rental…).
    placeTypes: placeTypeEnum("place_types").array(),
    createdBy: integer("created_by").references(() => userTable.id),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    // btree range-scans only the leading column (latitude); longitude is an
    // in-index filter. Fine at ~30k rows (D-003); revisit with cube/earthdistance
    // GiST if the dataset grows.
    index("watersport_spot_lat_lon_idx").on(t.latitude, t.longitude),
    index("watersport_spot_status_idx").on(t.status),
    uniqueIndex("watersport_spot_osm_id_key")
      .on(t.osmId)
      .where(sql`${t.osmId} IS NOT NULL`),
  ],
);

export type Spot = typeof spotTable.$inferSelect;
export type NewSpot = typeof spotTable.$inferInsert;

// A user's favorited spots (DB table `user_favorite` — user-scoped naming).
// Lives with the spot feature (not platform/user) so the FK to the spot doesn't
// force a platform→feature import. Feeds the weather hot-set (D-004).
export const favoriteTable = pgTable(
  "user_favorite",
  {
    id: idColumn(),
    uid: uidColumn(),
    userId: integer("user_id")
      .notNull()
      .references(() => userTable.id),
    spotId: integer("spot_id")
      .notNull()
      .references(() => spotTable.id),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex("user_favorite_user_spot_key").on(t.userId, t.spotId)],
);

export type Favorite = typeof favoriteTable.$inferSelect;
export type NewFavorite = typeof favoriteTable.$inferInsert;

// ─── weather (RFC-0005) ──────────────────────────────────────────────────────
// Demand-driven cache (D-004): a spot's weather is fetched on first request and
// re-fetched for the hot set (favorites) by a cron — never the whole world.
// Keyed by spot UID (text) rather than the internal id so the weather domain
// stays decoupled from spot's internal ids. Payload is canonical SI (D-006).
export const weatherCacheTable = pgTable(
  "weather_cache",
  {
    id: idColumn(),
    uid: uidColumn(),
    spotUid: text("spot_uid").notNull(),
    kind: weatherKindEnum("kind").notNull(),
    fetchedAt: timestamp("fetched_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),
    // The model run this payload came from (freshness/stale logic).
    modelRun: timestamp("model_run", { precision: 3, withTimezone: true }),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    expiresAt: timestamp("expires_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("weather_cache_spot_kind_key").on(t.spotUid, t.kind),
    index("weather_cache_expires_at_idx").on(t.expiresAt),
  ],
);

export type WeatherCache = typeof weatherCacheTable.$inferSelect;
export type NewWeatherCache = typeof weatherCacheTable.$inferInsert;

// Global model-run metadata (one row per model) — the "updated Xm ago / stale"
// story. Refreshed periodically, shared across all spots.
export const weatherModelMetaTable = pgTable("weather_model_meta", {
  id: idColumn(),
  uid: uidColumn(),
  model: text("model").notNull().unique(),
  lastRunAvailabilityTime: timestamp("last_run_availability_time", {
    precision: 3,
    withTimezone: true,
  }),
  updateIntervalSec: integer("update_interval_sec"),
  fetchedAt: timestamp("fetched_at", {
    precision: 3,
    withTimezone: true,
  }).notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export type WeatherModelMeta = typeof weatherModelMetaTable.$inferSelect;
export type NewWeatherModelMeta = typeof weatherModelMetaTable.$inferInsert;

// ─── activity / session (RFC-0006) ───────────────────────────────────────────
// 4-layer storage (activity-data-model.md): L0 raw is write-once immutable; L1
// derived is recomputable + carries algorithm/version metadata; L3 context is
// user-mutable. `spotUid` (text) references a watersport_spot loosely so the
// activity domain stays decoupled from spot's internal ids. All values SI (D-006).

// L0 — immutable identity + status + provenance + user context (L3 inline).
export const activityTable = pgTable(
  "activity",
  {
    id: idColumn(),
    uid: uidColumn(),
    userId: integer("user_id")
      .notNull()
      .references(() => userTable.id),
    sport: sportEnum("sport").notNull(),
    customName: text("custom_name"),
    status: activityStatusEnum("status").notNull().default("processing"),
    source: activitySourceEnum("source").notNull().default("iphone"),
    // Provenance of the raw track that produced the current L1 metrics. Stored on
    // each summary as `inputDataVersion`; reserved for a future corrected-track
    // re-upload. (P0 uploads are write-once, so this stays 1; recompute keys off
    // ALGORITHM_VERSION.)
    dataVersion: integer("data_version").notNull().default(1),

    // Time
    startedAt: timestamp("started_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),
    endedAt: timestamp("ended_at", { precision: 3, withTimezone: true }),
    timezone: text("timezone"),

    // Location (denormalized spot ref + coarse geo)
    spotUid: text("spot_uid"),
    spotName: text("spot_name"),
    startLat: doublePrecision("start_lat"),
    startLon: doublePrecision("start_lon"),
    endLat: doublePrecision("end_lat"),
    endLon: doublePrecision("end_lon"),

    // Provenance
    device: text("device"),
    deviceModel: text("device_model"),
    osVersion: text("os_version"),
    appVersion: text("app_version"),

    // L3 context (user-mutable)
    notes: text("notes"),
    feeling: text("feeling"),
    tags: text("tags").array(),
    perceivedEffort: integer("perceived_effort"),
    privacy: activityPrivacyEnum("privacy").notNull().default("private"),
    hideStart: boolean("hide_start").notNull().default(false),
    hiddenRadiusM: real("hidden_radius_m"),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index("activity_user_started_idx").on(t.userId, t.startedAt),
    index("activity_user_sport_idx").on(t.userId, t.sport),
  ],
);
export type Activity = typeof activityTable.$inferSelect;
export type NewActivity = typeof activityTable.$inferInsert;

// L0 — raw high-resolution GPS samples (immutable). One row per activity. The
// samples themselves live in object storage (S3, gzipped JSON) — too big for
// Postgres — and this row keeps only the pointer + count. `storageKey` resolves
// to an array of { t, lat, lon, speed?, hAccuracy?, sAccuracy? }, canonical SI
// (see the `Sample` interface in metrics.ts).
export const activityTrackTable = pgTable("activity_track", {
  id: idColumn(),
  uid: uidColumn(),
  activityId: integer("activity_id")
    .notNull()
    .unique()
    .references(() => activityTable.id, { onDelete: "cascade" }),
  sampleCount: integer("sample_count").notNull(),
  storageKey: text("storage_key").notNull(),
  createdAt: createdAtColumn(),
});
export type ActivityTrack = typeof activityTrackTable.$inferSelect;
export type NewActivityTrack = typeof activityTrackTable.$inferInsert;

// L0 — weather snapshot at record time (forecast now; observed later). Separate
// rows per kind so forecast-vs-reality is possible.
export const activityConditionTable = pgTable(
  "activity_condition",
  {
    id: idColumn(),
    uid: uidColumn(),
    activityId: integer("activity_id")
      .notNull()
      .references(() => activityTable.id, { onDelete: "cascade" }),
    kind: activityConditionKindEnum("kind").notNull(),
    provider: text("provider"),
    windSpeedMs: real("wind_speed_ms"),
    windGustsMs: real("wind_gusts_ms"),
    windDirectionDeg: real("wind_direction_deg"),
    temperatureC: real("temperature_c"),
    weatherCode: integer("weather_code"),
    capturedAt: timestamp("captured_at", {
      precision: 3,
      withTimezone: true,
    }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("activity_condition_activity_kind_key").on(
      t.activityId,
      t.kind,
    ),
  ],
);
export type ActivityCondition = typeof activityConditionTable.$inferSelect;
export type NewActivityCondition = typeof activityConditionTable.$inferInsert;

// L1 — core derived summary (one row per activity, recomputable).
export const activitySummaryTable = pgTable("activity_summary", {
  id: idColumn(),
  uid: uidColumn(),
  activityId: integer("activity_id")
    .notNull()
    .unique()
    .references(() => activityTable.id, { onDelete: "cascade" }),
  totalDistanceM: real("total_distance_m").notNull(),
  maxSpeedMs: real("max_speed_ms").notNull(),
  avgSpeedMs: real("avg_speed_ms").notNull(),
  avgMovingSpeedMs: real("avg_moving_speed_ms").notNull(),
  durationSec: real("duration_sec").notNull(),
  movingDurationSec: real("moving_duration_sec").notNull(),
  maxDistanceFromStartM: real("max_distance_from_start_m"),
  validSampleCount: integer("valid_sample_count").notNull(),
  gapCount: integer("gap_count").notNull().default(0),
  // L1 analysis metadata.
  algorithmVersion: integer("algorithm_version").notNull(),
  inputDataVersion: integer("input_data_version").notNull(),
  computedAt: timestamp("computed_at", {
    precision: 3,
    withTimezone: true,
  }).notNull(),
});
export type ActivitySummary = typeof activitySummaryTable.$inferSelect;
export type NewActivitySummary = typeof activitySummaryTable.$inferInsert;

// L1 — render-friendly route (one row per activity).
export const activityRouteTable = pgTable("activity_route", {
  id: idColumn(),
  uid: uidColumn(),
  activityId: integer("activity_id")
    .notNull()
    .unique()
    .references(() => activityTable.id, { onDelete: "cascade" }),
  polyline: text("polyline").notNull(),
  algorithmVersion: integer("algorithm_version").notNull(),
  computedAt: timestamp("computed_at", {
    precision: 3,
    withTimezone: true,
  }).notNull(),
});
export type ActivityRoute = typeof activityRouteTable.$inferSelect;
export type NewActivityRoute = typeof activityRouteTable.$inferInsert;

// L1 — best efforts (one row per effort; a table not jsonb so cross-session
// records/insights can query it — RFC-0007).
export const activityEffortTable = pgTable(
  "activity_effort",
  {
    id: idColumn(),
    uid: uidColumn(),
    activityId: integer("activity_id")
      .notNull()
      .references(() => activityTable.id, { onDelete: "cascade" }),
    type: effortTypeEnum("type").notNull(),
    // The effort result: average speed (m/s) over the window.
    resultMs: real("result_ms").notNull(),
    durationSec: real("duration_sec"),
    distanceM: real("distance_m"),
    // When in the session the effort occurred (seconds from start).
    startOffsetSec: real("start_offset_sec"),
    algorithmVersion: integer("algorithm_version").notNull(),
    computedAt: timestamp("computed_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),
  },
  (t) => [
    uniqueIndex("activity_effort_activity_type_key").on(t.activityId, t.type),
  ],
);
export type ActivityEffort = typeof activityEffortTable.$inferSelect;
export type NewActivityEffort = typeof activityEffortTable.$inferInsert;

// Reusable equipment library (per user).
export const equipmentProfileTable = pgTable("equipment_profile", {
  id: idColumn(),
  uid: uidColumn(),
  userId: integer("user_id")
    .notNull()
    .references(() => userTable.id),
  type: equipmentTypeEnum("type").notNull(),
  name: text("name").notNull(),
  // Type-specific attributes (volume/size/mast/boom/fin/frontWing…).
  attributes: jsonb("attributes").$type<JsonValue>(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
export type EquipmentProfile = typeof equipmentProfileTable.$inferSelect;
export type NewEquipmentProfile = typeof equipmentProfileTable.$inferInsert;

// activity ↔ equipment, with a snapshot of the profile's values AT record time
// (so editing the profile later never rewrites past sessions).
export const activityEquipmentTable = pgTable(
  "activity_equipment",
  {
    id: idColumn(),
    uid: uidColumn(),
    activityId: integer("activity_id")
      .notNull()
      .references(() => activityTable.id, { onDelete: "cascade" }),
    equipmentProfileId: integer("equipment_profile_id")
      .notNull()
      .references(() => equipmentProfileTable.id),
    role: text("role"),
    snapshot: jsonb("snapshot").$type<JsonValue>(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("activity_equipment_activity_profile_key").on(
      t.activityId,
      t.equipmentProfileId,
    ),
  ],
);
export type ActivityEquipment = typeof activityEquipmentTable.$inferSelect;
export type NewActivityEquipment = typeof activityEquipmentTable.$inferInsert;

// ─── Schema registry ────────────────────────────────────────────────────────
// Every domain appends its tables / enums / relations here. Drizzle's
// `db.query.*` API is generated from this object.
export const dbSchema = {
  user: userTable,
  refreshToken: refreshTokenTable,
  userProfile: userProfileTable,
  userSportProfile: userSportProfileTable,
  spot: spotTable,
  favorite: favoriteTable,
  weatherCache: weatherCacheTable,
  weatherModelMeta: weatherModelMetaTable,
  activity: activityTable,
  activityTrack: activityTrackTable,
  activityCondition: activityConditionTable,
  activitySummary: activitySummaryTable,
  activityRoute: activityRouteTable,
  activityEffort: activityEffortTable,
  equipmentProfile: equipmentProfileTable,
  activityEquipment: activityEquipmentTable,
};
