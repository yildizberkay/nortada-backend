import type { TaskWithSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";

export const SPOT_OSM_INGEST_TASK_ID = "spot-osm-ingest";

export const spotOsmIngestSchema = z.object({
  // ISO 3166-1 alpha-2 country code (e.g. "TR") — the Overpass area filter.
  // Normalized here too (not only at the route) so a cron/manual "tr" still
  // matches an OSM area.
  isoCountryCode: z
    .string()
    .length(2)
    .transform((s) => s.toUpperCase()),
});

export type SpotOsmIngestTask = TaskWithSchema<
  typeof SPOT_OSM_INGEST_TASK_ID,
  typeof spotOsmIngestSchema
>;
