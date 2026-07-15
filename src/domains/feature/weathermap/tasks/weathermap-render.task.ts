import { logger, schedules } from "@trigger.dev/sdk/v3";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

/** Render weather-map textures (every layer, the run's FULL horizon) for
 * every model whose run advanced (RFC-0011). The 15-min cadence is the POLL
 * rate — the "runTime < referenceTime" check in the service makes actual
 * rendering exactly as frequent as each model's own publication schedule
 * (hourly regionals, ~6 h globals). A cold-start backfill exceeds one
 * `maxDuration` window by design: frames upsert one by one, so successive
 * ticks resume where the previous one was cut off. */
export const weatherMapRenderTask = schedules.task({
  id: "weathermap-render",
  cron: "*/15 * * * *",
  maxDuration: 900,
  retry: { maxAttempts: 3 },
  queue: { concurrencyLimit: 1 },
  run: async () => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      const summary =
        await buildContainer(dbManager).weatherMapService.refresh();
      logger.info("Weather-map refresh done", { ...summary });
      // Per-model failures don't fail the run (the other models rendered),
      // but they must surface in tracking.
      for (const modelError of summary.errors) {
        Tracking.captureException(new Error(modelError.message), undefined, {
          taskId: "weathermap-render",
          model: modelError.model,
        });
      }
    } catch (error) {
      Tracking.captureException(error, undefined, {
        taskId: "weathermap-render",
      });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
