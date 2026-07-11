import type { Spot } from "@/db";
import type { RequestUser } from "@/types";

import { SpotReason } from "../errors";
import type { SpotRepository } from "../repositories/spot.repository";
import { SpotService } from "./spot.service";

const user: RequestUser = {
  id: 7,
  uid: "u7",
  isAnonymous: false,
  clerkUserId: "c7",
  isAdmin: false,
};

const spotRow = (overrides: Partial<Spot> = {}): Spot =>
  ({
    id: 1,
    uid: "spot-1",
    name: "Alaçatı",
    country: "TR",
    region: "İzmir",
    locality: "Çeşme",
    latitude: 38.27,
    longitude: 26.37,
    waterType: "bay",
    supportedSports: ["windsurf", "wingfoil"],
    skillSuitability: "all",
    shoreBearingDeg: 200,
    goodWindDirections: ["N", "NNW"],
    riskyWindDirections: ["S"],
    hazards: null,
    source: "curated",
    osmId: null,
    status: "published",
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Spot;

const mockRepo = {
  findNearby: jest.fn(),
  searchByName: jest.fn(),
  findByUid: jest.fn(),
  findByOsmId: jest.fn(),
  listByStatus: jest.fn(),
  create: jest.fn(),
  updateByUid: jest.fn(),
  bulkInsertOsmPending: jest.fn(),
} as unknown as jest.Mocked<SpotRepository>;

describe("SpotService", () => {
  let service: SpotService;

  beforeEach(() => {
    service = new SpotService(mockRepo);
  });

  describe("nearby", () => {
    it("maps rows and carries the distance", async () => {
      mockRepo.findNearby.mockResolvedValue([
        { ...spotRow(), distanceKm: 3.2 },
      ]);

      const result = await service.nearby({
        lat: 38.3,
        lon: 26.4,
        radiusKm: 50,
        limit: 50,
      });

      expect(result).toHaveLength(1);
      expect(result[0].uid).toBe("spot-1");
      expect(result[0].distanceKm).toBe(3.2);
      // internal columns are not surfaced
      expect(result[0]).not.toHaveProperty("id");
      expect(result[0]).not.toHaveProperty("osmId");
    });
  });

  describe("detail", () => {
    it("returns a published spot", async () => {
      mockRepo.findByUid.mockResolvedValue(spotRow());
      const result = await service.detail("spot-1");
      expect(result.name).toBe("Alaçatı");
    });

    it("hides a pending spot (404)", async () => {
      mockRepo.findByUid.mockResolvedValue(spotRow({ status: "pending" }));
      await expect(service.detail("spot-1")).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
        options: { reason: SpotReason.NOT_FOUND },
      });
    });

    it("throws when missing", async () => {
      mockRepo.findByUid.mockResolvedValue(undefined as never);
      await expect(service.detail("nope")).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
      });
    });
  });

  describe("suggest", () => {
    it("creates a pending, user-sourced spot", async () => {
      mockRepo.create.mockImplementation(async (v) =>
        spotRow({ ...(v as Partial<Spot>), uid: "new" }),
      );

      await service.suggest(user, {
        name: "New Spot",
        latitude: 40,
        longitude: 27,
        supportedSports: ["kitesurf"],
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "New Spot",
          source: "user_suggested",
          status: "pending",
          createdBy: 7,
          supportedSports: ["kitesurf"],
        }),
      );
    });
  });

  describe("moderate", () => {
    it("updates and returns the spot", async () => {
      mockRepo.updateByUid.mockResolvedValue(spotRow({ status: "published" }));
      const result = await service.moderate("spot-1", { status: "published" });
      expect(result.status).toBe("published");
      expect(mockRepo.updateByUid).toHaveBeenCalledWith("spot-1", {
        status: "published",
      });
    });

    it("throws when the spot is missing", async () => {
      mockRepo.updateByUid.mockResolvedValue(undefined as never);
      await expect(
        service.moderate("nope", { status: "published" }),
      ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
    });
  });
});
