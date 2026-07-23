import { and, desc, eq } from "drizzle-orm";

import type {
  Activity,
  ActivityCondition,
  ActivityEffort,
  ActivityRoute,
  ActivitySummary,
  ActivityTrack,
  DBManager,
  NewActivity,
  NewActivityCondition,
  NewActivityEffort,
  NewActivityEquipment,
  NewActivityRoute,
  NewActivitySummary,
  NewActivityTrack,
} from "@/db";
import type { DBExecutor } from "@/db/db.manager";
import {
  activityConditionTable,
  activityEffortTable,
  activityEquipmentTable,
  activityRouteTable,
  activitySummaryTable,
  activityTable,
  activityTrackTable,
} from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

// Explicit read allowlists (never SELECT *) — mirrors SpotRepository. Currently
// all columns, so a future private/large column never surfaces implicitly.
const activityColumns = {
  id: true,
  uid: true,
  userId: true,
  sport: true,
  customName: true,
  status: true,
  source: true,
  dataVersion: true,
  startedAt: true,
  endedAt: true,
  timezone: true,
  spotUid: true,
  spotName: true,
  startLat: true,
  startLon: true,
  endLat: true,
  endLon: true,
  markers: true,
  device: true,
  deviceModel: true,
  osVersion: true,
  appVersion: true,
  notes: true,
  feeling: true,
  tags: true,
  perceivedEffort: true,
  privacy: true,
  hideStart: true,
  hiddenRadiusM: true,
  createdAt: true,
  updatedAt: true,
} as const;

const activityTrackColumns = {
  id: true,
  uid: true,
  activityId: true,
  sampleCount: true,
  storageKey: true,
  createdAt: true,
} as const;

const activityConditionColumns = {
  id: true,
  uid: true,
  activityId: true,
  kind: true,
  provider: true,
  windSpeedMs: true,
  windGustsMs: true,
  windDirectionDeg: true,
  temperatureC: true,
  weatherCode: true,
  capturedAt: true,
  createdAt: true,
} as const;

const activitySummaryColumns = {
  id: true,
  uid: true,
  activityId: true,
  totalDistanceM: true,
  maxSpeedMs: true,
  avgSpeedMs: true,
  avgMovingSpeedMs: true,
  durationSec: true,
  movingDurationSec: true,
  maxDistanceFromStartM: true,
  validSampleCount: true,
  gapCount: true,
  algorithmVersion: true,
  inputDataVersion: true,
  computedAt: true,
} as const;

const activityRouteColumns = {
  id: true,
  uid: true,
  activityId: true,
  polyline: true,
  algorithmVersion: true,
  computedAt: true,
} as const;

const activityEffortColumns = {
  id: true,
  uid: true,
  activityId: true,
  type: true,
  resultMs: true,
  durationSec: true,
  distanceM: true,
  startOffsetSec: true,
  algorithmVersion: true,
  computedAt: true,
} as const;

export interface ActivityWithSummary {
  activity: Activity;
  summary: ActivitySummary | null;
}

/** L0 ingest payload — written in one transaction so track + conditions +
 * equipment links can never diverge on a partial failure. */
export interface IngestTrackInput {
  track: NewActivityTrack;
  conditions: NewActivityCondition[];
  equipmentLinks: NewActivityEquipment[];
}

export class ActivityRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  /** Idempotent create keyed on the client-provided uid — a retried upload
   * returns the existing row instead of duplicating. */
  async createActivity(values: NewActivity): Promise<Activity> {
    const [row] = await this.dbClient
      .insert(activityTable)
      .values(values)
      .onConflictDoNothing({ target: activityTable.uid })
      .returning();
    if (row) return row;
    const existing = await this.findByUid(values.uid as string);
    if (!existing) throw new Error("createActivity: conflict but no row found");
    return existing;
  }

  async findByUid(uid: string): Promise<Activity | undefined> {
    return this.dbClient.query.activity.findFirst({
      columns: activityColumns,
      where: eq(activityTable.uid, uid),
    });
  }

  async findByUidForUser(
    uid: string,
    userId: number,
  ): Promise<Activity | undefined> {
    return this.dbClient.query.activity.findFirst({
      columns: activityColumns,
      where: and(eq(activityTable.uid, uid), eq(activityTable.userId, userId)),
    });
  }

  async listByUser(
    userId: number,
    limit: number,
    sport?: Activity["sport"],
  ): Promise<ActivityWithSummary[]> {
    const rows = await this.dbClient
      .select({ activity: activityTable, summary: activitySummaryTable })
      .from(activityTable)
      .leftJoin(
        activitySummaryTable,
        eq(activitySummaryTable.activityId, activityTable.id),
      )
      .where(
        and(
          eq(activityTable.userId, userId),
          sport ? eq(activityTable.sport, sport) : undefined,
        ),
      )
      .orderBy(desc(activityTable.startedAt))
      .limit(limit);
    return rows;
  }

  async updateContext(
    uid: string,
    userId: number,
    values: Partial<NewActivity>,
  ): Promise<Activity | undefined> {
    const [row] = await this.dbClient
      .update(activityTable)
      .set(values)
      .where(and(eq(activityTable.uid, uid), eq(activityTable.userId, userId)))
      .returning();
    return row;
  }

  async setStatus(
    activityId: number,
    status: Activity["status"],
  ): Promise<void> {
    await this.dbClient
      .update(activityTable)
      .set({ status })
      .where(eq(activityTable.id, activityId));
  }

  /** Returns true if a row was deleted (children cascade). */
  async deleteByUid(uid: string, userId: number): Promise<boolean> {
    const deleted = await this.dbClient
      .delete(activityTable)
      .where(and(eq(activityTable.uid, uid), eq(activityTable.userId, userId)))
      .returning({ id: activityTable.id });
    return deleted.length > 0;
  }

  // ── L0 children ──────────────────────────────────────────────────────────────

  /** Ingest the immutable L0 track + its conditions + equipment links in ONE
   * transaction (so a partial failure never leaves a track without its context).
   * All inserts are conflict-safe, so a retried upload is a no-op. */
  async ingestTrack(input: IngestTrackInput): Promise<void> {
    await this.dbClient.transaction(async (tx) => {
      await tx
        .insert(activityTrackTable)
        .values(input.track)
        .onConflictDoNothing({ target: activityTrackTable.activityId });
      if (input.conditions.length > 0) {
        await tx
          .insert(activityConditionTable)
          .values(input.conditions)
          .onConflictDoNothing();
      }
      if (input.equipmentLinks.length > 0) {
        await tx
          .insert(activityEquipmentTable)
          .values(input.equipmentLinks)
          .onConflictDoNothing();
      }
    });
  }

  /** Cheap existence probe for the idempotency guard — never pulls the samples
   * jsonb blob (unlike `findTrackByActivityId`). */
  async trackExists(activityId: number): Promise<boolean> {
    const row = await this.dbClient.query.activityTrack.findFirst({
      columns: { id: true },
      where: eq(activityTrackTable.activityId, activityId),
    });
    return row !== undefined;
  }

  async findTrackByActivityId(
    activityId: number,
  ): Promise<ActivityTrack | undefined> {
    return this.dbClient.query.activityTrack.findFirst({
      columns: activityTrackColumns,
      where: eq(activityTrackTable.activityId, activityId),
    });
  }

  async findConditionsByActivityId(
    activityId: number,
  ): Promise<ActivityCondition[]> {
    return this.dbClient.query.activityCondition.findMany({
      columns: activityConditionColumns,
      where: eq(activityConditionTable.activityId, activityId),
    });
  }

  // ── L1 derived (recomputable) ─────────────────────────────────────────────────

  async upsertSummary(values: NewActivitySummary): Promise<void> {
    const { activityId, ...rest } = values;
    await this.dbClient
      .insert(activitySummaryTable)
      .values(values)
      .onConflictDoUpdate({
        target: activitySummaryTable.activityId,
        set: rest,
      });
  }

  async findSummaryByActivityId(
    activityId: number,
  ): Promise<ActivitySummary | undefined> {
    return this.dbClient.query.activitySummary.findFirst({
      columns: activitySummaryColumns,
      where: eq(activitySummaryTable.activityId, activityId),
    });
  }

  async upsertRoute(values: NewActivityRoute): Promise<void> {
    const { activityId, ...rest } = values;
    await this.dbClient
      .insert(activityRouteTable)
      .values(values)
      .onConflictDoUpdate({ target: activityRouteTable.activityId, set: rest });
  }

  async findRouteByActivityId(
    activityId: number,
  ): Promise<ActivityRoute | undefined> {
    return this.dbClient.query.activityRoute.findFirst({
      columns: activityRouteColumns,
      where: eq(activityRouteTable.activityId, activityId),
    });
  }

  /** Clean recompute: replace all efforts for the activity. */
  async replaceEfforts(
    activityId: number,
    values: NewActivityEffort[],
  ): Promise<void> {
    await this.dbClient
      .delete(activityEffortTable)
      .where(eq(activityEffortTable.activityId, activityId));
    if (values.length > 0) {
      await this.dbClient.insert(activityEffortTable).values(values);
    }
  }

  async findEffortsByActivityId(activityId: number): Promise<ActivityEffort[]> {
    return this.dbClient.query.activityEffort.findMany({
      columns: activityEffortColumns,
      where: eq(activityEffortTable.activityId, activityId),
    });
  }

  /** Merge hook (D-008): move the user's activities to the target account. */
  async reassignOwner(
    fromUserId: number,
    toUserId: number,
    tx: DBExecutor,
  ): Promise<void> {
    await tx
      .update(activityTable)
      .set({ userId: toUserId })
      .where(eq(activityTable.userId, fromUserId));
  }
}
