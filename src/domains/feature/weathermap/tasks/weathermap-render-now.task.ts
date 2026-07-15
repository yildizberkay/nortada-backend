import { logger, schemaTask } from "@trigger.dev/sdk/v3";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

import {
  WEATHERMAP_RENDER_NOW_TASK_ID,
  weathermapRenderNowSchema,
} from "./weathermap-render-now.schema";

/** Manual force-run of the weather-map render (RFC-0011 §8) — same
 * `refresh()` the cron task calls, so it shares the run-advance idempotence:
 * a force-run after an unchanged run is a cheap no-op unless you narrow the
 * payload. Trigger it from the Trigger.dev dashboard (or `tasks.trigger`)
 * with `{}` for a full pass, or `{ models, layers, horizonHours }` to render
 * a specific slice. Local/dev without Trigger: `npm run weathermap:render`. */
export const weathermapRenderNowTask = schemaTask({
  id: WEATHERMAP_RENDER_NOW_TASK_ID,
  schema: weathermapRenderNowSchema,
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async (payload) => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      const summary = await buildContainer(dbManager).weatherMapService.refresh(
        new Date(),
        payload,
      );
      logger.info("Weather-map force-run done", { ...summary, ...payload });
      return summary;
    } catch (error) {
      Tracking.captureException(error, undefined, {
        taskId: WEATHERMAP_RENDER_NOW_TASK_ID,
      });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
