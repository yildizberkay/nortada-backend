import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";
import { GenericError } from "@/packages/error";

import {
  WEATHERMAP_RENDER_MODEL_TASK_ID,
  weathermapRenderModelSchema,
} from "./weathermap-render-model.schema";

/** Fan-out child (RFC-0011 §8): renders every due (layer, valid hour) frame
 * of ONE model, with a machine to itself — triggered by
 * `weathermap-orchestrate` for models whose run advanced, never scheduled
 * directly. The queue bounds how many models render at once ACROSS machines:
 * every child range-reads the same Open-Meteo archive host, so this is a
 * rate-limit knob, not a memory one (memory is per-machine now).
 * `maxDuration` covers a cold-start backfill of the longest-horizon model in
 * one run; a cut-off run resumes on retry / next orchestration because frames
 * upsert one by one.
 * Machine: medium-1x (1 vCPU / 2 GB) — the cost-optimal preset: same
 * per-second price as small-2x (which OOM-killed in prod 2026-07-16; global
 * models hold ~120 MB of grids per in-flight hour plus encode buffers), and
 * 2 GB funds up to `CHILD_HOUR_CONCURRENCY = 4` concurrent hours (ADAPTIVE
 * per model: the first hour's measured grid bytes decide how many fit the
 * memory budget — grid-heavy models drop down instead of OOMing) — the
 * ~12 min long-horizon runs with parallelism instead of a 2×-price
 * medium-2x whose second vCPU can't speed up the single-threaded JS packing
 * loops anyway. Revisit against the run output's `profile` ratios: encode-
 * dominated → medium-2x or a lower WEBP_EFFORT; fetch-dominated → this. */
export const weathermapRenderModelTask = schemaTask({
  id: WEATHERMAP_RENDER_MODEL_TASK_ID,
  schema: weathermapRenderModelSchema,
  machine: "medium-1x",
  maxDuration: 3600,
  retry: { maxAttempts: 3 },
  queue: { concurrencyLimit: 10 },
  run: async (payload) => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      const summary = await buildContainer(
        dbManager,
      ).weatherMapService.refreshModelById(payload.model);
      logger.info("Weather-map model render done", { ...summary, ...payload });
      return summary;
    } catch (error) {
      Tracking.captureException(error, undefined, {
        taskId: WEATHERMAP_RENDER_MODEL_TASK_ID,
        model: payload.model,
      });
      // An unknown/disabled model can't heal by retrying — the registry
      // changed under a queued run.
      if (error instanceof GenericError) {
        throw new AbortTaskRunError(error.message);
      }
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
