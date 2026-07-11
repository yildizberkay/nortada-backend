import type { TaskWithSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";

export const ACTIVITY_COMPUTE_METRICS_TASK_ID = "activity-compute-metrics";

export const activityComputeMetricsSchema = z.object({
  activityUid: z.string().uuid(),
});

export type ActivityComputeMetricsTask = TaskWithSchema<
  typeof ACTIVITY_COMPUTE_METRICS_TASK_ID,
  typeof activityComputeMetricsSchema
>;
