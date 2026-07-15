import type { EquipmentProfile } from "@/db";
import type { RequestUser } from "@/types";

import type { EquipmentRepository } from "../repositories/equipment.repository";
import { EquipmentService } from "./equipment.service";

const user: RequestUser = {
  id: 1,
  uid: "u1",
  isAnonymous: false,
  clerkUserId: "c1",
  isAdmin: false,
};

const mockRepo = {
  create: jest.fn(),
  listByUser: jest.fn(),
  deleteByUidForUser: jest.fn(),
} as unknown as jest.Mocked<EquipmentRepository>;

describe("EquipmentService", () => {
  let service: EquipmentService;

  beforeEach(() => {
    service = new EquipmentService(mockRepo);
  });

  it("creates equipment for the user", async () => {
    mockRepo.create.mockResolvedValue({
      uid: "eq-1",
      type: "sail",
      name: "Severne 5.0",
      attributes: { size: 5.0 },
    } as unknown as EquipmentProfile);

    const result = await service.create(user, {
      type: "sail",
      name: "Severne 5.0",
      attributes: { size: 5.0 },
    });

    expect(mockRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, type: "sail", name: "Severne 5.0" }),
    );
    expect(result).toEqual({
      uid: "eq-1",
      type: "sail",
      name: "Severne 5.0",
      attributes: { size: 5.0 },
    });
  });

  it("lists the user's equipment", async () => {
    mockRepo.listByUser.mockResolvedValue([
      { uid: "eq-1", type: "board", name: "JP", attributes: null },
    ] as EquipmentProfile[]);

    const result = await service.list(user);
    expect(result.equipment).toHaveLength(1);
    expect(result.equipment[0].uid).toBe("eq-1");
  });

  it("deletes an owned entry", async () => {
    mockRepo.deleteByUidForUser.mockResolvedValue(true);
    await expect(service.delete(user, "eq-1")).resolves.toBeUndefined();
    expect(mockRepo.deleteByUidForUser).toHaveBeenCalledWith("eq-1", 1);
  });

  it("404s a missing or foreign uid", async () => {
    mockRepo.deleteByUidForUser.mockResolvedValue(false);
    await expect(service.delete(user, "nope")).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
    });
  });
});
