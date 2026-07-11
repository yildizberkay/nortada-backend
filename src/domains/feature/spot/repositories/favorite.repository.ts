import { and, desc, eq, inArray } from "drizzle-orm";

import type { DBManager, Spot } from "@/db";
import type { DBExecutor } from "@/db/db.manager";
import { favoriteTable, spotTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

import type { SpotGeo } from "../types";

export class FavoriteRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  /**
   * Distinct PUBLISHED spots favorited by anyone — the weather hot set (D-004).
   * A spot favorited by many users appears once.
   */
  async listDistinctFavoritedSpotGeos(): Promise<SpotGeo[]> {
    return this.dbClient
      .selectDistinct({
        uid: spotTable.uid,
        latitude: spotTable.latitude,
        longitude: spotTable.longitude,
        shoreBearingDeg: spotTable.shoreBearingDeg,
        supportedSports: spotTable.supportedSports,
      })
      .from(favoriteTable)
      .innerJoin(spotTable, eq(favoriteTable.spotId, spotTable.id))
      .where(eq(spotTable.status, "published"));
  }

  /** The user's favorited spots, most-recently-favorited first. */
  async listSpotsByUser(userId: number): Promise<Spot[]> {
    const rows = await this.dbClient
      .select({ spot: spotTable })
      .from(favoriteTable)
      .innerJoin(spotTable, eq(favoriteTable.spotId, spotTable.id))
      .where(eq(favoriteTable.userId, userId))
      .orderBy(desc(favoriteTable.createdAt));
    return rows.map((r) => r.spot);
  }

  /** Adds a favorite; returns false if it already existed (idempotent). */
  async add(userId: number, spotId: number): Promise<boolean> {
    const inserted = await this.dbClient
      .insert(favoriteTable)
      .values({ userId, spotId })
      .onConflictDoNothing({
        target: [favoriteTable.userId, favoriteTable.spotId],
      })
      .returning({ id: favoriteTable.id });
    return inserted.length > 0;
  }

  /** Removes a favorite; returns false if it didn't exist. */
  async remove(userId: number, spotId: number): Promise<boolean> {
    const deleted = await this.dbClient
      .delete(favoriteTable)
      .where(
        and(eq(favoriteTable.userId, userId), eq(favoriteTable.spotId, spotId)),
      )
      .returning({ id: favoriteTable.id });
    return deleted.length > 0;
  }

  /**
   * Move an anonymous user's favorites to the target on account-link (D-008).
   * Runs on the caller's transaction executor so it's atomic with the rest of
   * the merge. Drops source rows that would collide with a favorite the target
   * already has (the `(user_id, spot_id)` unique) before moving the rest.
   */
  async reassignOwner(
    fromUserId: number,
    toUserId: number,
    tx: DBExecutor,
  ): Promise<void> {
    const targetSpotIds = tx
      .select({ spotId: favoriteTable.spotId })
      .from(favoriteTable)
      .where(eq(favoriteTable.userId, toUserId));

    await tx
      .delete(favoriteTable)
      .where(
        and(
          eq(favoriteTable.userId, fromUserId),
          inArray(favoriteTable.spotId, targetSpotIds),
        ),
      );

    await tx
      .update(favoriteTable)
      .set({ userId: toUserId })
      .where(eq(favoriteTable.userId, fromUserId));
  }
}
