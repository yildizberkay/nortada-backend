import type { NewSpot } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { createLogger } from "@/packages/logger";
import type { OverpassClient, OverpassElement } from "@/packages/overpass";

import type { SpotRepository } from "../repositories/spot.repository";

type Sport = NewSpot["supportedSports"][number];
type WaterType = NonNullable<NewSpot["waterType"]>;

const log = createLogger("SpotIngestService");

const OSM_SPORT_MAP: Record<string, Sport> = {
  windsurfing: "windsurf",
  kitesurfing: "kitesurf",
  sailing: "sailing",
  canoe: "kayak",
  kayak: "kayak",
};

/**
 * Normalize one Overpass element into a pending OSM spot, or null if it can't
 * be a usable spot (no coordinate or no name). Pure — the ingest IP lives here
 * and is unit-tested independently of the HTTP fetch.
 */
export function normalizeOverpassElement(
  element: OverpassElement,
  isoCountryCode: string,
): NewSpot | null {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  const tags = element.tags ?? {};
  const name = tags.name ?? tags["name:en"];
  if (!name) return null; // unnamed POIs aren't presentable spots

  const sports = new Set<Sport>();
  if (tags.sport) {
    for (const raw of tags.sport.split(";")) {
      const mapped = OSM_SPORT_MAP[raw.trim()];
      if (mapped) sports.add(mapped);
    }
  }
  // Marinas / nautical centres / harbours are sailing hubs.
  if (
    tags.leisure === "marina" ||
    tags.leisure === "nautical_center" ||
    tags.sport === "nautical_center" ||
    tags["seamark:type"] === "harbour"
  ) {
    sports.add("sailing");
  }
  const supportedSports: Sport[] = sports.size > 0 ? [...sports] : ["other"];

  let waterType: WaterType | null = null;
  if (tags.leisure === "marina") waterType = "marina";

  return {
    name,
    latitude: lat,
    longitude: lon,
    country: isoCountryCode,
    locality: tags["addr:city"] ?? null,
    waterType,
    supportedSports,
    source: "osm",
    osmId: `${element.type}/${element.id}`,
    status: "pending",
  };
}

export interface IngestResult {
  fetched: number;
  normalized: number;
  inserted: number;
}

export class SpotIngestService extends BaseUseCase {
  constructor(
    private readonly overpassClient: OverpassClient,
    private readonly spotRepository: SpotRepository,
  ) {
    super();
  }

  /**
   * Bulk-seed pending OSM spots for a country. New `osmId`s insert as pending;
   * already-seen ones are skipped so curation edits survive a re-ingest. The
   * shoreBearing / good-wind-direction enrichment is admin/curation work
   * (RFC-0004 §6) — a coastline-tangent auto-derivation is a P1 follow-up.
   */
  async ingestByCountry(isoCountryCode: string): Promise<IngestResult> {
    const elements = await this.overpassClient.fetchByCountry(isoCountryCode);

    const candidates = elements
      .map((el) => normalizeOverpassElement(el, isoCountryCode))
      .filter((s): s is NewSpot => s !== null);

    const inserted = await this.spotRepository.bulkInsertOsmPending(candidates);

    log.info("OSM ingest complete", {
      isoCountryCode,
      fetched: elements.length,
      normalized: candidates.length,
      inserted,
    });

    return {
      fetched: elements.length,
      normalized: candidates.length,
      inserted,
    };
  }
}
