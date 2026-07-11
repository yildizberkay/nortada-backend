import { globalConfig } from "@/app/global-config";
import type { DBManager } from "@/db";
import { getDBClient, getDBManager } from "@/db/db.manager";

/**
 * Base class for repositories — the only layer allowed to hold a `dbClient`
 * and use Drizzle operators/`*Table` refs. Pass an `externalDBManager` for
 * Trigger.dev tasks (per-task pool); omit it for the HTTP singleton.
 */
export class BaseRepository {
  constructor(private readonly externalDBManager?: DBManager) {}

  get dbManager() {
    return this.externalDBManager ?? getDBManager();
  }

  get dbClient() {
    return this.externalDBManager?.client ?? getDBClient();
  }

  get config() {
    return globalConfig.config;
  }
}
