import { and, desc, eq } from "drizzle-orm";

import type { DBManager, Spot } from "@/db";
import { favoriteTable, spotTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

export class FavoriteRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
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
}
