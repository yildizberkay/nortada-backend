import { logger, schedules } from "@trigger.dev/sdk/v3";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";
import { GenericError } from "@/packages/error";

/** Refresh the global Open-Meteo model-run metadata (the "updated Xm ago" /
 * stale story). Cheap, global — hourly is plenty. */
export const weatherModelMetaRefreshTask = schedules.task({
  id: "weather-model-meta-refresh",
  cron: "0 * * * *",
  maxDuration: 120,
  retry: { maxAttempts: 3 },
  queue: { concurrencyLimit: 1 },
  run: async () => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      await buildContainer(dbManager).weatherService.refreshModelMeta();
      logger.info("Weather model meta refreshed");
      return { ok: true };
    } catch (error) {
      // End-of-run report: surface the provider status + URL (carried in the
      // GenericError debug data) so a 404 names the exact endpoint that broke.
      if (error instanceof GenericError && error.options?.data) {
        logger.error("Weather model meta refresh report: provider failure", {
          ...error.options.data,
        });
      }
      Tracking.captureException(error, undefined, {
        taskId: "weather-model-meta-refresh",
      });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
