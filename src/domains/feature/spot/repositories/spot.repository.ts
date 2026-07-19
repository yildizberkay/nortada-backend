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
import type { DBExecutor } from "@/db/db.manager";
import { spotTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";
import { boundingBox, longitudeRanges } from "@/packages/geo";

const EARTH_RADIUS_KM = 6371;

// Explicit read allowlist (never SELECT *). `suggestionNotes` is the one
// moderator-facing column here — it rides every read for the admin queue's
// sake, and `toSpotResponse` (the only public mapper) deliberately omits it.
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
  suggestionNotes: true,
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
  /** RFC-0012: also surface THIS user's private spots (owner-only rows). */
  visibleToUserId?: number;
}

/** Published rows, plus the requesting user's own private rows (RFC-0012:
 * private spots are visible only to their owner, everywhere). */
const visibilityFilter = (visibleToUserId?: number): SQL | undefined =>
  visibleToUserId == null
    ? eq(spotTable.status, "published")
    : or(
        eq(spotTable.status, "published"),
        and(
          eq(spotTable.status, "private"),
          eq(spotTable.createdBy, visibleToUserId),
        ),
      );

export class SpotRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  /**
   * Visible spots within `radiusKm` (published + the caller's own private
   * rows), nearest first. Cheap `(lat, lon)` bbox pre-filter narrows the
   * index scan; the exact haversine both orders and enforces the true
   * circular radius. No PostGIS (D-003).
   */
  async findNearby(params: NearbyParams): Promise<SpotWithDistance[]> {
    const { lat, lon, radiusKm, sport, limit, visibleToUserId } = params;
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
      visibilityFilter(visibleToUserId),
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
    visibleToUserId?: number,
  ): Promise<Spot[]> {
    // Escape LIKE wildcards so a user's `%`/`_`/`\` are literal, not match-all.
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    return this.dbClient.query.spot.findMany({
      columns: spotColumns,
      where: and(
        visibilityFilter(visibleToUserId),
        ilike(spotTable.name, `%${escaped}%`),
        sport ? arrayContains(spotTable.supportedSports, [sport]) : undefined,
      ),
      limit,
    });
  }

  /** D-008 merge hook: private spots follow their owner onto the target
   * account — without this, the visibility filter (`createdBy` match)
   * strands every private row on the pre-link anonymous id. */
  async reassignPrivateOwner(
    fromUserId: number,
    toUserId: number,
    tx: DBExecutor,
  ): Promise<void> {
    await tx
      .update(spotTable)
      .set({ createdBy: toUserId })
      .where(
        and(
          eq(spotTable.status, "private"),
          eq(spotTable.createdBy, fromUserId),
        ),
      );
  }

  /** How many private spots this user owns — the RFC-0012 cap guard. */
  async countPrivateByOwner(userId: number): Promise<number> {
    const [row] = await this.dbClient
      .select({ count: sql<number>`count(*)::int` })
      .from(spotTable)
      .where(
        and(eq(spotTable.status, "private"), eq(spotTable.createdBy, userId)),
      );
    return row?.count ?? 0;
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
