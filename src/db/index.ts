// Barrel for the DB layer. Domains import DB types/managers from `@/db`; the
// concrete Drizzle operators and `*Table` refs stay behind the repository layer.

export type { DBClient, DBManager } from "./db.manager";
export { DrizzleDBManager } from "./db.manager";
export type { JsonArray, JsonObject, JsonValue, NewUser, User } from "./schema";
