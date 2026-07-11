import { logger, schedules } from "@trigger.dev/sdk/v3";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

/**
 * Re-fetch the weather hot set (favorited spots) on a cadence — demand-driven
 * refresh, NEVER the whole world (D-004). A cron `schedules.task` (no payload).
 */
export const weatherRefreshTask = schedules.task({
  id: "weather-refresh",
  // Every 30 min — the "now" tick is a model nowcast that wants freshness.
  cron: "*/30 * * * *",
  maxDuration: 300,
  retry: { maxAttempts: 3 },
  queue: { concurrencyLimit: 1 },
  run: async () => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      const services = buildContainer(dbManager);
      const result = await services.weatherService.refreshHotSet();
      logger.info("Weather hot-set refreshed", result);
      return result;
    } catch (error) {
      Tracking.captureException(error, undefined, {
        taskId: "weather-refresh",
      });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
