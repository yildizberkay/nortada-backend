import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  pgTable,
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

// ─── Schema registry ────────────────────────────────────────────────────────
// Every domain appends its tables / enums / relations here. Drizzle's
// `db.query.*` API is generated from this object.
export const dbSchema = {
  user: userTable,
};
