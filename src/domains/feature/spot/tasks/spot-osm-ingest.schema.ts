import type { TaskWithSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";

export const SPOT_OSM_INGEST_TASK_ID = "spot-osm-ingest";

export const spotOsmIngestSchema = z.object({
  // ISO 3166-1 alpha-2 country code (e.g. "TR") — the Overpass area filter.
  isoCountryCode: z.string().length(2),
});

export type SpotOsmIngestTask = TaskWithSchema<
  typeof SPOT_OSM_INGEST_TASK_ID,
  typeof spotOsmIngestSchema
>;
