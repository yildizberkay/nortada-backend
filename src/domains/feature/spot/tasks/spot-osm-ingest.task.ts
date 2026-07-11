import { logger, schemaTask } from "@trigger.dev/sdk/v3";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

import {
  SPOT_OSM_INGEST_TASK_ID,
  spotOsmIngestSchema,
} from "./spot-osm-ingest.schema";

/**
 * First Trigger.dev task — the canonical pattern for Splash: initialize config,
 * build a per-task DB graph, run the service, always reset the pool in
 * `finally`. Fetches a country's watersports POIs from OSM Overpass and seeds
 * pending spots for admin curation (RFC-0004 §7).
 */
export const spotOsmIngestTask = schemaTask({
  id: SPOT_OSM_INGEST_TASK_ID,
  schema: spotOsmIngestSchema,
  // Overpass can take ~90s for a whole country.
  maxDuration: 300,
  run: async (payload) => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    const services = buildContainer(dbManager);

    try {
      const result = await logger.trace("ingest-by-country", () =>
        services.spotIngestService.ingestByCountry(payload.isoCountryCode),
      );
      logger.info("Spot OSM ingest finished", { ...result, ...payload });
      return result;
    } catch (error) {
      Tracking.captureException(error, undefined, {
        taskId: SPOT_OSM_INGEST_TASK_ID,
        isoCountryCode: payload.isoCountryCode,
      });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
