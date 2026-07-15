import {
  and,
  arrayContains,
  eq,
  getTableColumns,
  gte,
  ilike,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import type { DBManager, NewSpot, Spot } from "@/db";
import { spotTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";
import { boundingBox, longitudeRanges } from "@/packages/geo";

const EARTH_RADIUS_KM = 6371;

// Explicit read allowlist (never SELECT *). Spot has no sensitive columns today,
// but this keeps the repo consistent with the rest of the codebase and stops a
// future private column from silently surfacing.
const spotColumns = {
  id: true,
  uid: true,
  name: true,
  country: true,
  region: true,
  locality: true,
  latitude: true,
  longitude: true,
  waterType: true,
  supportedSports: true,
  skillSuitability: true,
  shoreBearingDeg: true,
  goodWindDirections: true,
  riskyWindDirections: true,
  hazards: true,
  source: true,
  osmId: true,
  status: true,
  onWater: true,
  placeTypes: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type SpotWithDistance = Spot & { distanceKm: number };

export interface NearbyParams {
  lat: number;
  lon: number;
  radiusKm: number;
  sport?: Spot["supportedSports"][number];
  limit: number;
}

export class SpotRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  /**
   * Published spots within `radiusKm`, nearest first. Cheap `(lat, lon)` bbox
   * pre-filter narrows the index scan; the exact haversine both orders and
   * enforces the true circular radius. No PostGIS (D-003).
   */
  async findNearby(params: NearbyParams): Promise<SpotWithDistance[]> {
    const { lat, lon, radiusKm, sport, limit } = params;
    const bb = boundingBox(lat, lon, radiusKm);

    // acos arg clamped to [-1, 1] to dodge float rounding domain errors.
    const distanceKm = sql<number>`(
      ${EARTH_RADIUS_KM} * acos(least(1, greatest(-1,
        cos(radians(${lat})) * cos(radians(${spotTable.latitude})) *
          cos(radians(${spotTable.longitude}) - radians(${lon})) +
        sin(radians(${lat})) * sin(radians(${spotTable.latitude}))
      )))
    )`;

    // Longitude may wrap the antimeridian → 1-2 OR'd ranges.
    const lonFilter = or(
      ...longitudeRanges(bb.lonMin, bb.lonMax).map(([lo, hi]) =>
        and(gte(spotTable.longitude, lo), lte(spotTable.longitude, hi)),
      ),
    );

    const filters: (SQL | undefined)[] = [
      eq(spotTable.status, "published"),
      gte(spotTable.latitude, bb.latMin),
      lte(spotTable.latitude, bb.latMax),
      lonFilter,
      sql`${distanceKm} <= ${radiusKm}`,
      sport ? arrayContains(spotTable.supportedSports, [sport]) : undefined,
    ];

    const rows = await this.dbClient
      .select({ ...getTableColumns(spotTable), distanceKm })
      .from(spotTable)
      .where(and(...filters))
      .orderBy(distanceKm)
      .limit(limit);

    return rows;
  }

  async searchByName(
    q: string,
    limit: number,
    sport?: Spot["supportedSports"][number],
  ): Promise<Spot[]> {
    // Escape LIKE wildcards so a user's `%`/`_`/`\` are literal, not match-all.
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    return this.dbClient.query.spot.findMany({
      columns: spotColumns,
      where: and(
        eq(spotTable.status, "published"),
        ilike(spotTable.name, `%${escaped}%`),
        sport ? arrayContains(spotTable.supportedSports, [sport]) : undefined,
      ),
      limit,
    });
  }

  async findByUid(uid: string): Promise<Spot | undefined> {
    return this.dbClient.query.spot.findFirst({
      columns: spotColumns,
      where: eq(spotTable.uid, uid),
    });
  }

  async findByOsmId(osmId: string): Promise<Spot | undefined> {
    return this.dbClient.query.spot.findFirst({
      columns: spotColumns,
      where: eq(spotTable.osmId, osmId),
    });
  }

  async listByStatus(status: Spot["status"], limit: number): Promise<Spot[]> {
    return this.dbClient.query.spot.findMany({
      columns: spotColumns,
      where: eq(spotTable.status, status),
      limit,
    });
  }

  async create(values: NewSpot): Promise<Spot> {
    const [row] = await this.dbClient
      .insert(spotTable)
      .values(values)
      .returning();
    return row;
  }

  async updateByUid(
    uid: string,
    values: Partial<NewSpot>,
  ): Promise<Spot | undefined> {
    const [row] = await this.dbClient
      .update(spotTable)
      .set(values)
      .where(eq(spotTable.uid, uid))
      .returning();
    return row;
  }

  /**
   * Idempotent bulk seed for the OSM ingest (RFC-0004 §7). New OSM elements
   * insert as `pending`; already-seen `osmId`s are skipped (curation edits are
   * never clobbered by a re-ingest).
   */
  async bulkInsertOsmPending(values: NewSpot[]): Promise<number> {
    if (values.length === 0) return 0;
    const inserted = await this.dbClient
      .insert(spotTable)
      .values(values)
      // osm_id is a PARTIAL unique index (WHERE osm_id IS NOT NULL); the
      // conflict target must repeat that predicate or Postgres can't use it
      // as an arbiter (42P10).
      .onConflictDoNothing({
        target: spotTable.osmId,
        where: sql`${spotTable.osmId} IS NOT NULL`,
      })
      .returning({ id: spotTable.id });
    return inserted.length;
  }
}
