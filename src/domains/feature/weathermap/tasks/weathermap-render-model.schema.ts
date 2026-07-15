import type { TaskWithSchema } from "@trigger.dev/sdk";
import { z } from "zod";

export const WEATHERMAP_RENDER_MODEL_TASK_ID = "weathermap-render-model";

/**
 * Fan-out child payload — ONE enabled registry model per run. No
 * run/referenceTime travels here: the child re-reads `latest.json` itself, so
 * if the run advanced since the orchestrator planned, the child renders the
 * newer one. (The (model, run) idempotency key lives on the trigger call in
 * the orchestrator, not in the payload.)
 */
export const weathermapRenderModelSchema = z.object({
  // data_spatial model id, e.g. "dwd_icon_eu".
  model: z.string().min(1),
});

export type WeathermapRenderModelTask = TaskWithSchema<
  typeof WEATHERMAP_RENDER_MODEL_TASK_ID,
  typeof weathermapRenderModelSchema
>;
