import {
  and,
  arrayContains,
  eq,
  getTableColumns,
  gte,
  ilike,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";

import type { DBManager, NewSpot, Spot } from "@/db";
import { spotTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";
import { boundingBox } from "@/packages/geo";

const EARTH_RADIUS_KM = 6371;

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

    const filters: (SQL | undefined)[] = [
      eq(spotTable.status, "published"),
      gte(spotTable.latitude, bb.latMin),
      lte(spotTable.latitude, bb.latMax),
      gte(spotTable.longitude, bb.lonMin),
      lte(spotTable.longitude, bb.lonMax),
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
    return this.dbClient
      .select()
      .from(spotTable)
      .where(
        and(
          eq(spotTable.status, "published"),
          ilike(spotTable.name, `%${q}%`),
          sport ? arrayContains(spotTable.supportedSports, [sport]) : undefined,
        ),
      )
      .limit(limit);
  }

  async findByUid(uid: string): Promise<Spot | undefined> {
    return this.dbClient.query.spot.findFirst({
      where: eq(spotTable.uid, uid),
    });
  }

  async findByOsmId(osmId: string): Promise<Spot | undefined> {
    return this.dbClient.query.spot.findFirst({
      where: eq(spotTable.osmId, osmId),
    });
  }

  async listByStatus(status: Spot["status"], limit: number): Promise<Spot[]> {
    return this.dbClient
      .select()
      .from(spotTable)
      .where(eq(spotTable.status, status))
      .limit(limit);
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
      .onConflictDoNothing({ target: spotTable.osmId })
      .returning({ id: spotTable.id });
    return inserted.length;
  }
}
