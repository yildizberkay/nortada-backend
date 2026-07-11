import { tasks } from "@trigger.dev/sdk/v3";

import {
  ACTIVITY_COMPUTE_METRICS_TASK_ID,
  type ActivityComputeMetricsTask,
} from "./activity-compute-metrics.schema";

/** Enqueue metric computation for a freshly-uploaded activity. */
export const triggerActivityComputeMetrics = async (activityUid: string) => {
  const handle = await tasks.trigger<ActivityComputeMetricsTask>(
    ACTIVITY_COMPUTE_METRICS_TASK_ID,
    { activityUid },
  );
  return handle.id;
};
