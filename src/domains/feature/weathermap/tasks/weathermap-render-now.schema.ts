import type { TaskWithSchema } from "@trigger.dev/sdk";
import { z } from "zod";

export const WEATHERMAP_RENDER_NOW_TASK_ID = "weathermap-render-now";

/**
 * Force-run payload — everything optional; `{}` renders the full active set,
 * same as one cron tick. Narrowing can only select within the enabled
 * registry (a disabled model/layer stays off).
 */
export const weathermapRenderNowSchema = z.object({
  // data_spatial model ids, e.g. ["dwd_icon_eu"].
  models: z.array(z.string().min(1)).optional(),
  // Layer registry ids, e.g. ["wind", "temperature"].
  layers: z.array(z.string().min(1)).optional(),
  horizonHours: z.number().int().positive().max(48).optional(),
});

export type WeathermapRenderNowTask = TaskWithSchema<
  typeof WEATHERMAP_RENDER_NOW_TASK_ID,
  typeof weathermapRenderNowSchema
>;
