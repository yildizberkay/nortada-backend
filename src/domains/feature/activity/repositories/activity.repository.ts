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

export interface ActivityWithSummary {
  activity: Activity;
  summary: ActivitySummary | null;
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
      where: eq(activityTable.uid, uid),
    });
  }

  async findByUidForUser(
    uid: string,
    userId: number,
  ): Promise<Activity | undefined> {
    return this.dbClient.query.activity.findFirst({
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

  async insertTrack(values: NewActivityTrack): Promise<void> {
    await this.dbClient
      .insert(activityTrackTable)
      .values(values)
      .onConflictDoNothing({ target: activityTrackTable.activityId });
  }

  async findTrackByActivityId(
    activityId: number,
  ): Promise<ActivityTrack | undefined> {
    return this.dbClient.query.activityTrack.findFirst({
      where: eq(activityTrackTable.activityId, activityId),
    });
  }

  async insertConditions(values: NewActivityCondition[]): Promise<void> {
    if (values.length === 0) return;
    await this.dbClient
      .insert(activityConditionTable)
      .values(values)
      .onConflictDoNothing();
  }

  async findConditionsByActivityId(
    activityId: number,
  ): Promise<ActivityCondition[]> {
    return this.dbClient
      .select()
      .from(activityConditionTable)
      .where(eq(activityConditionTable.activityId, activityId));
  }

  async insertEquipmentLink(values: NewActivityEquipment): Promise<void> {
    await this.dbClient
      .insert(activityEquipmentTable)
      .values(values)
      .onConflictDoNothing();
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
    return this.dbClient
      .select()
      .from(activityEffortTable)
      .where(eq(activityEffortTable.activityId, activityId));
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
