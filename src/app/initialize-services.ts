import { configure } from "@trigger.dev/sdk";

import { globalConfig } from "@/app/global-config";
import type { DBManager } from "@/db/db.manager";
import { getOrCreateDBManager } from "@/db/db.manager";

/** App startup — called once before the HTTP server starts. */
export const initializeApp = async () => {
  globalConfig.initialize();
  if (process.env.TRIGGER_SECRET_KEY) {
    configure({ secretKey: process.env.TRIGGER_SECRET_KEY });
  }
  await getOrCreateDBManager();
};

/** Trigger.dev task entry — reads config from process.env. */
export const initializeForTrigger = () => {
  process.env.TRIGGER_WORKER = "true";
  globalConfig.initialize();
};

/**
 * Trigger.dev task cleanup — resets the per-task DB pool. We reset (not tear
 * down shared clients) so the long-lived worker stays warm for the next task.
 */
export const finalizeTrigger = async (dbManager: DBManager) => {
  await dbManager.reset();
};
