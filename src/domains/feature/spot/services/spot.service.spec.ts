import type { Spot } from "@/db";
import type { RequestUser } from "@/types";

import { SpotReason } from "../errors";
import type { FavoriteRepository } from "../repositories/favorite.repository";
import type { SpotRepository } from "../repositories/spot.repository";
import { triggerSpotOsmIngest } from "../tasks/spot-osm-ingest.trigger";
import { SpotService } from "./spot.service";

jest.mock("../tasks/spot-osm-ingest.trigger", () => ({
  triggerSpotOsmIngest: jest.fn(),
}));
const mockTrigger = triggerSpotOsmIngest as jest.MockedFunction<
  typeof triggerSpotOsmIngest
>;

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
    suggestionNotes: null,
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
  countPrivateByOwner: jest.fn(),
} as unknown as jest.Mocked<SpotRepository>;

const mockFavoriteRepo = {
  listDistinctFavoritedSpotGeos: jest.fn(),
} as unknown as jest.Mocked<FavoriteRepository>;

describe("SpotService", () => {
  let service: SpotService;

  beforeEach(() => {
    service = new SpotService(mockRepo, mockFavoriteRepo);
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

    it("passes the caller through for private-spot visibility (RFC-0012)", async () => {
      mockRepo.findNearby.mockResolvedValue([]);

      await service.nearby(
        { lat: 38.3, lon: 26.4, radiusKm: 50, limit: 50 },
        user,
      );

      expect(mockRepo.findNearby).toHaveBeenCalledWith(
        expect.objectContaining({ visibleToUserId: user.id }),
      );
    });
  });

  describe("search", () => {
    it("maps matched spots and passes the sport filter through", async () => {
      mockRepo.searchByName.mockResolvedValue([spotRow()]);

      const result = await service.search({
        q: "ala",
        sport: "windsurf",
        limit: 20,
      });

      expect(mockRepo.searchByName).toHaveBeenCalledWith(
        "ala",
        20,
        "windsurf",
        undefined,
      );
      expect(result[0].uid).toBe("spot-1");
      expect(result[0]).not.toHaveProperty("id");
    });
  });

  describe("listByStatus", () => {
    it("lists spots for a moderation status", async () => {
      mockRepo.listByStatus.mockResolvedValue([spotRow({ status: "pending" })]);

      const result = await service.listByStatus("pending", 50);

      expect(mockRepo.listByStatus).toHaveBeenCalledWith("pending", 50);
      expect(result[0].status).toBe("pending");
    });
  });

  describe("detail", () => {
    it("returns a published spot", async () => {
      mockRepo.findByUid.mockResolvedValue(spotRow());
      const result = await service.detail("spot-1");
      expect(result.name).toBe("Alaçatı");
    });

    it("shows the owner their own private spot", async () => {
      mockRepo.findByUid.mockResolvedValue(
        spotRow({ status: "private", createdBy: user.id }),
      );
      const result = await service.detail("spot-1", user);
      expect(result.status).toBe("private");
    });

    it("hides another user's private spot (404)", async () => {
      mockRepo.findByUid.mockResolvedValue(
        spotRow({ status: "private", createdBy: 999 }),
      );
      await expect(service.detail("spot-1", user)).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
        options: { reason: SpotReason.NOT_FOUND },
      });
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

    it("persists the suggester's directions and notes", async () => {
      mockRepo.create.mockImplementation(async (v) =>
        spotRow({ ...(v as Partial<Spot>), uid: "new" }),
      );

      const result = await service.suggest(user, {
        name: "New Spot",
        latitude: 40,
        longitude: 27,
        supportedSports: ["kitesurf"],
        goodWindDirections: ["NW", "WNW"],
        riskyWindDirections: ["S"],
        notes: "Launch behind the pier; shallows on the east side.",
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          goodWindDirections: ["NW", "WNW"],
          riskyWindDirections: ["S"],
          suggestionNotes: "Launch behind the pier; shallows on the east side.",
        }),
      );
      // The public response must not leak the moderator-facing note.
      expect(result).not.toHaveProperty("suggestionNotes");
    });
  });

  describe("listByStatus", () => {
    it("carries suggestionNotes for the moderation queue", async () => {
      mockRepo.listByStatus.mockResolvedValue([
        spotRow({ suggestionNotes: "check access road" }),
      ]);
      const rows = await service.listByStatus("pending", 50);
      expect(rows[0]?.suggestionNotes).toBe("check access road");
    });
  });

  describe("getGeoByUid", () => {
    it("returns geo for a published spot", async () => {
      mockRepo.findByUid.mockResolvedValue(spotRow());
      const geo = await service.getGeoByUid("spot-1");
      expect(geo).toEqual({
        uid: "spot-1",
        latitude: 38.27,
        longitude: 26.37,
        shoreBearingDeg: 200,
        supportedSports: ["windsurf", "wingfoil"],
      });
    });

    it("throws NOT_FOUND for a non-published spot", async () => {
      mockRepo.findByUid.mockResolvedValue(spotRow({ status: "pending" }));
      await expect(service.getGeoByUid("spot-1")).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
      });
    });

    it("resolves a private spot (RFC-0012 — weather runs for its owner)", async () => {
      mockRepo.findByUid.mockResolvedValue(
        spotRow({ status: "private", createdBy: 7 }),
      );
      const geo = await service.getGeoByUid("spot-1");
      expect(geo.uid).toBe("spot-1");
    });
  });

  describe("createPrivate (RFC-0012)", () => {
    it("creates an owned private row from the exact tapped coordinate", async () => {
      mockRepo.countPrivateByOwner.mockResolvedValue(0);
      mockRepo.create.mockResolvedValue(
        spotRow({
          status: "private",
          source: "user_private",
          createdBy: user.id,
        }),
      );

      const result = await service.createPrivate(user, {
        name: "Gizli Koy",
        latitude: 40.98765,
        longitude: 29.03214,
        sport: "windsurf",
      });

      expect(mockRepo.create).toHaveBeenCalledWith({
        name: "Gizli Koy",
        latitude: 40.98765,
        longitude: 29.03214,
        supportedSports: ["windsurf"],
        source: "user_private",
        status: "private",
        createdBy: user.id,
      });
      expect(result.status).toBe("private");
    });

    it("rejects past the per-user cap", async () => {
      mockRepo.countPrivateByOwner.mockResolvedValue(50);

      await expect(
        service.createPrivate(user, {
          name: "Bir Koy Daha",
          latitude: 40,
          longitude: 29,
          sport: "windsurf",
        }),
      ).rejects.toMatchObject({
        errorCode: "CONFLICT",
        options: { reason: SpotReason.PRIVATE_SPOT_LIMIT },
      });
      expect(mockRepo.create).not.toHaveBeenCalled();
    });
  });

  describe("listHotSpotGeos", () => {
    it("delegates to the favorite repo", async () => {
      const geos = [{ uid: "spot-1" }];
      mockFavoriteRepo.listDistinctFavoritedSpotGeos.mockResolvedValue(
        geos as never,
      );
      expect(await service.listHotSpotGeos()).toBe(geos);
    });
  });

  describe("requestOsmIngest", () => {
    it("enqueues the ingest task and returns its id", async () => {
      mockTrigger.mockResolvedValue("run_abc");

      const result = await service.requestOsmIngest("TR");

      expect(mockTrigger).toHaveBeenCalledWith("TR");
      expect(result).toEqual({ taskId: "run_abc" });
    });
  });

  describe("moderate", () => {
    it("updates and returns the spot", async () => {
      mockRepo.findByUid.mockResolvedValue(spotRow({ status: "pending" }));
      mockRepo.updateByUid.mockResolvedValue(spotRow({ status: "published" }));
      const result = await service.moderate("spot-1", { status: "published" });
      expect(result.status).toBe("published");
      expect(mockRepo.updateByUid).toHaveBeenCalledWith("spot-1", {
        status: "published",
      });
    });

    it("throws when the spot is missing", async () => {
      mockRepo.findByUid.mockResolvedValue(undefined as never);
      await expect(
        service.moderate("nope", { status: "published" }),
      ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
      expect(mockRepo.updateByUid).not.toHaveBeenCalled();
    });

    it("refuses to touch a private spot (RFC-0012)", async () => {
      mockRepo.findByUid.mockResolvedValue(
        spotRow({ status: "private", createdBy: 42 }),
      );
      await expect(
        service.moderate("spot-1", { status: "published" }),
      ).rejects.toMatchObject({ errorCode: "FORBIDDEN" });
      expect(mockRepo.updateByUid).not.toHaveBeenCalled();
    });
  });
});
