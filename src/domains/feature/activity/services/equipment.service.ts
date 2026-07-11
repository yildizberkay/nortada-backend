import type { EquipmentProfile, JsonValue } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import type { RequestUser } from "@/types";

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
}
