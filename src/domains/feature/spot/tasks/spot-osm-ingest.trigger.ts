import { tasks } from "@trigger.dev/sdk/v3";

import {
  SPOT_OSM_INGEST_TASK_ID,
  type SpotOsmIngestTask,
} from "./spot-osm-ingest.schema";

/** Enqueue an OSM ingest for a country. Invoked from the admin route. */
export const triggerSpotOsmIngest = async (isoCountryCode: string) => {
  const handle = await tasks.trigger<SpotOsmIngestTask>(
    SPOT_OSM_INGEST_TASK_ID,
    { isoCountryCode },
  );
  return handle.id;
};
