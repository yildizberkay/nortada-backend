import { and, desc, eq } from "drizzle-orm";

import type { DBManager, EquipmentProfile, NewEquipmentProfile } from "@/db";
import type { DBExecutor } from "@/db/db.manager";
import { equipmentProfileTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

// Explicit read allowlist (never SELECT *) — mirrors SpotRepository.
const equipmentProfileColumns = {
  id: true,
  uid: true,
  userId: true,
  type: true,
  name: true,
  attributes: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class EquipmentRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  async create(values: NewEquipmentProfile): Promise<EquipmentProfile> {
    const [row] = await this.dbClient
      .insert(equipmentProfileTable)
      .values(values)
      .returning();
    return row;
  }

  async listByUser(userId: number): Promise<EquipmentProfile[]> {
    return this.dbClient.query.equipmentProfile.findMany({
      columns: equipmentProfileColumns,
      where: eq(equipmentProfileTable.userId, userId),
      orderBy: desc(equipmentProfileTable.createdAt),
    });
  }

  async findByUidForUser(
    uid: string,
    userId: number,
  ): Promise<EquipmentProfile | undefined> {
    return this.dbClient.query.equipmentProfile.findFirst({
      columns: equipmentProfileColumns,
      where: and(
        eq(equipmentProfileTable.uid, uid),
        eq(equipmentProfileTable.userId, userId),
      ),
    });
  }

  /** Owner-scoped delete → true when a row was removed. */
  async deleteByUidForUser(uid: string, userId: number): Promise<boolean> {
    const rows = await this.dbClient
      .delete(equipmentProfileTable)
      .where(
        and(
          eq(equipmentProfileTable.uid, uid),
          eq(equipmentProfileTable.userId, userId),
        ),
      )
      .returning({ id: equipmentProfileTable.id });
    return rows.length > 0;
  }

  /** Merge hook (D-008): move the user's equipment to the target account. */
  async reassignOwner(
    fromUserId: number,
    toUserId: number,
    tx: DBExecutor,
  ): Promise<void> {
    await tx
      .update(equipmentProfileTable)
      .set({ userId: toUserId })
      .where(eq(equipmentProfileTable.userId, fromUserId));
  }
}
