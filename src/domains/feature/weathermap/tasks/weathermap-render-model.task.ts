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
 * Machine: DYNAMIC per model — this preset (medium-1x, 2 GB) is only the
 * default; the orchestrator requests the registry's `renderMachine`
 * (medium-2x for the grid-heavy globals) at trigger time, and the adaptive
 * hour concurrency reads the ACTUAL machine from `ctx.machine`, so light
 * regionals render cheaply while heavies get the memory they measurably
 * need. Sized from prod RSS data (2026-07-16): on 2 GB even a light model's
 * successful run peaked at maxRssBytes 1.90 GB (glibc keeps freed pages in
 * per-thread arenas — RSS tracks the high-water mark, not live bytes) and
 * `ecmwf_ifs` OOM-killed there even sequentially; a crashed run is 100%
 * wasted spend. */
export const weathermapRenderModelTask = schemaTask({
  id: WEATHERMAP_RENDER_MODEL_TASK_ID,
  schema: weathermapRenderModelSchema,
  machine: "medium-1x",
  maxDuration: 3600,
  retry: { maxAttempts: 3 },
  queue: { concurrencyLimit: 10 },
  run: async (payload, { ctx }) => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      // ctx.machine.memory is in GB — the adaptive hour concurrency sizes
      // itself to whatever machine the orchestrator actually requested.
      const machineMemoryBytes = ctx.machine?.memory
        ? ctx.machine.memory * 1024 * 1024 * 1024
        : undefined;
      const summary = await buildContainer(
        dbManager,
      ).weatherMapService.refreshModelById(
        payload.model,
        new Date(),
        machineMemoryBytes,
      );
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
