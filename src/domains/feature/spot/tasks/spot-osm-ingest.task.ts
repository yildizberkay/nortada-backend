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
 * First Trigger.dev task — the canonical pattern for Nortada: initialize config,
 * build a per-task DB graph, run the service, always reset the pool in
 * `finally`. Fetches a country's watersports POIs from OSM Overpass and seeds
 * pending spots for admin curation (RFC-0004 §7).
 */
export const spotOsmIngestTask = schemaTask({
  id: SPOT_OSM_INGEST_TASK_ID,
  schema: spotOsmIngestSchema,
  // Overpass can take ~90s for a whole country.
  maxDuration: 300,
  retry: { maxAttempts: 3 },
  // Bound concurrency: Overpass (like most external data APIs) rate-limits by
  // IP — never fan out. Every external-API task should copy this.
  queue: { concurrencyLimit: 1 },
  run: async (payload) => {
    initializeForTrigger();
    // Acquire the per-task pool first, then build+run inside try so a failure
    // anywhere still hits `finally` and resets the pool (no leak).
    const dbManager = await createDBManagerForTrigger();
    try {
      const services = buildContainer(dbManager);
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
