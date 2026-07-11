import { sql } from "drizzle-orm";
import { integer, text, timestamp } from "drizzle-orm/pg-core";

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

// ─── Schema registry ────────────────────────────────────────────────────────
// Every domain appends its tables / enums / relations here. Drizzle's
// `db.query.*` API is generated from this object. Empty until RFC-0002 adds the
// first tables.
export const dbSchema = {};
