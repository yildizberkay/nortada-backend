import { logger, schedules } from "@trigger.dev/sdk/v3";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

/** Refresh the global Open-Meteo model-run metadata (the "updated Xm ago" /
 * stale story). Cheap, global — hourly is plenty. */
export const weatherModelMetaRefreshTask = schedules.task({
  id: "weather-model-meta-refresh",
  cron: "0 * * * *",
  maxDuration: 120,
  queue: { concurrencyLimit: 1 },
  run: async () => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      await buildContainer(dbManager).weatherService.refreshModelMeta();
      logger.info("Weather model meta refreshed");
    } catch (error) {
      Tracking.captureException(error, undefined, {
        taskId: "weather-model-meta-refresh",
      });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
