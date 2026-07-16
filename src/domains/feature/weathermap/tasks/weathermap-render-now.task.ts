import { logger, schemaTask } from "@trigger.dev/sdk";

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

/** Manual force-run of the weather-map render (RFC-0011 §8): one full
 * IN-PROCESS pass over the active set — unlike the cron path, which fans out
 * per model via `weathermap-orchestrate`. It shares the run-advance
 * idempotence, so a force-run after unchanged runs is a cheap no-op unless
 * you narrow the payload. Trigger it from the Trigger.dev dashboard (or
 * `tasks.trigger`) with `{}` for a full pass, or
 * `{ models, layers, horizonHours }` to render a specific slice. Local/dev
 * without Trigger: `npm run weathermap:render`. */
export const weathermapRenderNowTask = schemaTask({
  id: WEATHERMAP_RENDER_NOW_TASK_ID,
  schema: weathermapRenderNowSchema,
  // The full in-process pass holds up to MODEL_CONCURRENCY (4) models' grids
  // at once (~100 MB each for a global hour) — the 0.5 GB default OOMs; the
  // per-model child only ever holds 2 hours of ONE model, hence its small-2x.
  machine: "medium-1x",
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
