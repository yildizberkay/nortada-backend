import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import { globalConfig } from "@/app/global-config";
import { createLogger } from "@/packages/logger";

import { dbSchema } from "./schema";

const logger = createLogger("db");

const createPool = () => {
  const pool = new Pool({
    connectionString: globalConfig.config.database.url,
    max: 10,
  });
  pool.on("error", (err) => {
    logger.error("PostgreSQL pool error", { error: String(err) });
  });
  return pool;
};

const createDrizzleClient = (pool: Pool) => {
  return drizzle(pool, { schema: dbSchema });
};

export type DBClient = ReturnType<typeof createDrizzleClient>;

/**
 * Something you can run queries on — the full client OR a transaction handle.
 * Both extend `PgDatabase`, so a repo method can accept either and participate
 * in a caller-opened transaction (used by the D-008 merge reassign). The
 * generic params are irrelevant to the merge writes, hence `any`.
 */
export type DBExecutor = PgDatabase<any, any, any>;

export interface DBManager {
  client: DBClient;
  reset: () => Promise<void>;
}

export class DrizzleDBManager implements DBManager {
  private _pool?: Pool;
  private _drizzleClient?: DBClient;

  async initialize() {
    if (this._drizzleClient) return;
    this._pool = createPool();
    this._drizzleClient = createDrizzleClient(this._pool);
  }

  get client() {
    if (!this._drizzleClient) {
      throw new Error("DB is not initialized");
    }
    return this._drizzleClient;
  }

  reset = async () => {
    if (this._pool) {
      await this._pool.end();
      this._pool = undefined;
      this._drizzleClient = undefined;
    }
  };
}

const singletonDBManager = new DrizzleDBManager();

/** Returns the singleton DB manager (initializes on first call). */
export const getOrCreateDBManager = async (): Promise<DBManager> => {
  await singletonDBManager.initialize();
  return singletonDBManager;
};

export const getDBManager = (): DBManager => {
  return singletonDBManager;
};

export const getDBClient = (): DBClient => {
  return singletonDBManager.client;
};

/**
 * Creates a fresh DB manager for a Trigger.dev task — a per-task pool that the
 * caller MUST `reset()` when the task finishes (via `finalizeTrigger`).
 */
export const createDBManagerForTrigger = async (): Promise<DBManager> => {
  const dbManager = new DrizzleDBManager();
  await dbManager.initialize();
  return dbManager;
};
