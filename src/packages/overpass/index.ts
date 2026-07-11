import { globalConfig } from "@/app/global-config";
import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";

const logger = createLogger("overpass");

// A single Overpass element (node/way/relation). Ways/relations are fetched
// with `out center`, so their coordinate arrives under `center`.
export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

// Watersports POIs within a country area. Mirrors the query in
// docs/spot-model-and-sourcing.md §2.
const buildCountryQuery = (isoCountryCode: string): string => `
[out:json][timeout:120];
area["ISO3166-1"="${isoCountryCode}"]->.a;
(
  nwr(area.a)["sport"~"windsurfing|kitesurfing|sailing|surfing"];
  nwr(area.a)["sport"="nautical_center"];
  nwr(area.a)["leisure"~"marina|slipway|nautical_center"];
  nwr(area.a)["seamark:type"="harbour"];
);
out center tags;
`;

/**
 * Thin Overpass API client. Reads the endpoint from config lazily (at call
 * time) so construction stays cheap and import-safe. Not a domain repository —
 * it talks to an external HTTP API, so it lives in packages/.
 */
export class OverpassClient {
  async fetchByCountry(isoCountryCode: string): Promise<OverpassElement[]> {
    const url = globalConfig.config.osm.overpassUrl;
    const query = buildCountryQuery(isoCountryCode);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: query,
      });
    } catch (error) {
      logger.error("Overpass request failed", { error: String(error) });
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: "Overpass API request failed",
      });
    }

    if (!response.ok) {
      logger.error("Overpass returned non-OK", { status: response.status });
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: `Overpass API returned ${response.status}`,
      });
    }

    const body = (await response.json()) as OverpassResponse;
    return body.elements ?? [];
  }
}
