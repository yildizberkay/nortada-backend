import type { Spot } from "@/db";
import type { RequestUser } from "@/types";

import { SpotReason } from "../errors";
import type { FavoriteRepository } from "../repositories/favorite.repository";
import type { SpotRepository } from "../repositories/spot.repository";
import { FavoriteService } from "./favorite.service";

const user: RequestUser = {
  id: 7,
  uid: "u7",
  isAnonymous: false,
  clerkUserId: "c7",
  isAdmin: false,
};

const spot = { id: 1, uid: "spot-1", status: "published" } as Spot;

const mockFavoriteRepo = {
  listSpotsByUser: jest.fn(),
  add: jest.fn(),
  remove: jest.fn(),
} as unknown as jest.Mocked<FavoriteRepository>;

const mockSpotRepo = {
  findByUid: jest.fn(),
} as unknown as jest.Mocked<SpotRepository>;

describe("FavoriteService", () => {
  let service: FavoriteService;

  beforeEach(() => {
    service = new FavoriteService(mockFavoriteRepo, mockSpotRepo);
  });

  describe("add", () => {
    it("adds a favorite for an existing spot", async () => {
      mockSpotRepo.findByUid.mockResolvedValue(spot);
      mockFavoriteRepo.add.mockResolvedValue(true);

      const result = await service.add(user, "spot-1");

      expect(mockFavoriteRepo.add).toHaveBeenCalledWith(7, 1);
      expect(result.uid).toBe("spot-1");
    });

    it("throws NOT_FOUND when the spot doesn't exist", async () => {
      mockSpotRepo.findByUid.mockResolvedValue(undefined as never);
      await expect(service.add(user, "nope")).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
        options: { reason: SpotReason.NOT_FOUND },
      });
    });

    it("throws ALREADY_EXISTS when already favorited", async () => {
      mockSpotRepo.findByUid.mockResolvedValue(spot);
      mockFavoriteRepo.add.mockResolvedValue(false);
      await expect(service.add(user, "spot-1")).rejects.toMatchObject({
        errorCode: "ALREADY_EXISTS",
        options: { reason: SpotReason.ALREADY_FAVORITED },
      });
    });

    it("lets the owner favorite their own private spot (RFC-0012)", async () => {
      mockSpotRepo.findByUid.mockResolvedValue({
        ...spot,
        status: "private",
        createdBy: user.id,
      } as Spot);
      mockFavoriteRepo.add.mockResolvedValue(true);

      const result = await service.add(user, "spot-1");

      expect(result.status).toBe("private");
    });

    it("hides another user's private spot behind NOT_FOUND", async () => {
      mockSpotRepo.findByUid.mockResolvedValue({
        ...spot,
        status: "private",
        createdBy: 999,
      } as Spot);

      await expect(service.add(user, "spot-1")).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
        options: { reason: SpotReason.NOT_FOUND },
      });
      expect(mockFavoriteRepo.add).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("removes an existing favorite", async () => {
      mockSpotRepo.findByUid.mockResolvedValue(spot);
      mockFavoriteRepo.remove.mockResolvedValue(true);
      await expect(service.remove(user, "spot-1")).resolves.toBeUndefined();
      expect(mockFavoriteRepo.remove).toHaveBeenCalledWith(7, 1);
    });

    it("throws when the favorite doesn't exist", async () => {
      mockSpotRepo.findByUid.mockResolvedValue(spot);
      mockFavoriteRepo.remove.mockResolvedValue(false);
      await expect(service.remove(user, "spot-1")).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
        options: { reason: SpotReason.FAVORITE_NOT_FOUND },
      });
    });
  });

  describe("list", () => {
    it("maps favorited spots to responses", async () => {
      mockFavoriteRepo.listSpotsByUser.mockResolvedValue([
        { ...spot, name: "Alaçatı" } as Spot,
      ]);
      const result = await service.list(user);
      expect(result[0].uid).toBe("spot-1");
    });
  });
});
