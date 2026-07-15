import type { EquipmentProfile, JsonValue } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import type { RequestUser } from "@/types";

import { ActivityReason } from "../errors";
import type { EquipmentRepository } from "../repositories/equipment.repository";
import type { CreateEquipmentInput } from "../schemas";

const toDto = (e: EquipmentProfile) => ({
  uid: e.uid,
  type: e.type,
  name: e.name,
  attributes: (e.attributes ?? null) as Record<string, unknown> | null,
});

export class EquipmentService extends BaseUseCase {
  constructor(private readonly equipmentRepository: EquipmentRepository) {
    super();
  }

  async list(user: RequestUser) {
    const rows = await this.equipmentRepository.listByUser(user.id);
    return { equipment: rows.map(toDto) };
  }

  async create(user: RequestUser, input: CreateEquipmentInput) {
    const created = await this.equipmentRepository.create({
      userId: user.id,
      type: input.type,
      name: input.name,
      attributes: (input.attributes ?? null) as JsonValue,
    });
    return toDto(created);
  }

  /** Remove a library entry. Sessions keep their activity_equipment
   * snapshots — this never rewrites recorded history. Missing and
   * someone-else's uids are indistinguishable (404). */
  async delete(user: RequestUser, uid: string): Promise<void> {
    const removed = await this.equipmentRepository.deleteByUidForUser(
      uid,
      user.id,
    );
    if (!removed) {
      throw new GenericError("NOT_FOUND", {
        reason: ActivityReason.NOT_FOUND,
        message: "Equipment not found",
      });
    }
  }
}
