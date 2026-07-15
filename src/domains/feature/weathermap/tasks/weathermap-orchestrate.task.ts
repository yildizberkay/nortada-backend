import { idempotencyKeys, logger, schedules } from "@trigger.dev/sdk";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

import { weathermapRenderModelTask } from "./weathermap-render-model.task";

const TASK_ID = "weathermap-orchestrate";

/** Weather-map fan-out orchestrator (RFC-0011 §8). The 15-min cadence is the
 * POLL rate: per model, one cheap `latest.json` GET + one frame query decide
 * whether any (layer, valid hour) is due — only due models get a
 * `weathermap-render-model` child run, so child runs track each model's own
 * publication schedule (hourly regionals, ~6 h globals), not the cron. The
 * global-scoped (model, run) idempotency key dedupes re-triggers while a
 * child is still working the same run; its 1 h TTL lets an
 * interrupted/partial render be re-fanned afterwards (frames upsert one by
 * one, so children resume where they were cut off). Pruning lives here —
 * children never prune. */
export const weathermapOrchestrateTask = schedules.task({
  id: TASK_ID,
  cron: "*/15 * * * *",
  maxDuration: 300,
  retry: { maxAttempts: 3 },
  queue: { concurrencyLimit: 1 },
  run: async () => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      const weatherMapService = buildContainer(dbManager).weatherMapService;
      const plan = await weatherMapService.planRefresh();
      // Per-model plan failures don't fail the tick (the other models still
      // fan out), but they must surface in tracking.
      for (const modelError of plan.errors) {
        Tracking.captureException(new Error(modelError.message), undefined, {
          taskId: TASK_ID,
          model: modelError.model,
        });
      }
      if (plan.due.length > 0) {
        const items = await Promise.all(
          plan.due.map(async (due) => ({
            payload: { model: due.model },
            options: {
              idempotencyKey: await idempotencyKeys.create(
                `weathermap-render-${due.model}-${due.referenceTime}`,
                { scope: "global" },
              ),
              idempotencyKeyTTL: "1h",
              tags: [`model:${due.model}`],
            },
          })),
        );
        await weathermapRenderModelTask.batchTrigger(items);
      }
      const pruned = await weatherMapService.prune(new Date());
      logger.info("Weather-map orchestration done", {
        checked: plan.checked,
        due: plan.due,
        errors: plan.errors.length,
        pruned,
      });
    } catch (error) {
      Tracking.captureException(error, undefined, { taskId: TASK_ID });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
