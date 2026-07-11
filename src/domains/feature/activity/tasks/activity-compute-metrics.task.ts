import { logger, schemaTask } from "@trigger.dev/sdk/v3";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

import {
  ACTIVITY_COMPUTE_METRICS_TASK_ID,
  activityComputeMetricsSchema,
} from "./activity-compute-metrics.schema";

/**
 * Canonical metric computation from a raw GPS track (D-001). Re-runnable when
 * ALGORITHM_VERSION bumps. Follows the Splash Trigger pattern: acquire a per-task
 * pool, build the graph, always reset in `finally`.
 */
export const activityComputeMetricsTask = schemaTask({
  id: ACTIVITY_COMPUTE_METRICS_TASK_ID,
  schema: activityComputeMetricsSchema,
  maxDuration: 300,
  retry: { maxAttempts: 3 },
  run: async (payload) => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      const services = buildContainer(dbManager);
      await logger.trace("compute-metrics", () =>
        services.activityMetricsService.computeAndStore(payload.activityUid),
      );
      logger.info("Activity metrics done", payload);
    } catch (error) {
      Tracking.captureException(error, undefined, {
        taskId: ACTIVITY_COMPUTE_METRICS_TASK_ID,
        activityUid: payload.activityUid,
      });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
