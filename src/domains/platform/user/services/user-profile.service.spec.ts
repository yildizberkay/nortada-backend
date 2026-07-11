import type { UserProfile, UserSportProfile } from "@/db";
import type { RequestUser } from "@/types";

import type { UserProfileRepository } from "../repositories/user-profile.repository";
import { UserProfileService } from "./user-profile.service";

const user: RequestUser = {
  id: 1,
  uid: "u1",
  isAnonymous: true,
  clerkUserId: null,
  isAdmin: false,
};

const profileRow = (overrides: Partial<UserProfile> = {}): UserProfile =>
  ({
    id: 10,
    uid: "prof-1",
    userId: 1,
    primarySport: "windsurf",
    sports: ["windsurf"],
    experience: "intermediate",
    goal: "improve_speed",
    focus: "speed",
    activityFilter: null,
    cardSlots: ["distance", "time_on_water", "best_5x10", "sessions"],
    defaultActivityPeriod: "week",
    windUnit: "kt",
    distanceUnit: "km",
    temperatureUnit: "c",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as UserProfile;

const sportRow = (
  overrides: Partial<UserSportProfile> = {},
): UserSportProfile =>
  ({
    id: 5,
    uid: "sp-1",
    userId: 1,
    sport: "sup",
    cardSlots: null,
    planingThresholdMps: null,
    foilingThresholdMps: null,
    prefs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as UserSportProfile;

const mockRepo = {
  findByUserId: jest.fn(),
  upsertProfileWithLock: jest.fn(),
  listSportProfilesByUserId: jest.fn(),
  findSportProfile: jest.fn(),
  upsertSportProfile: jest.fn(),
} as unknown as jest.Mocked<UserProfileRepository>;

// Drives the lock-based upsert: run the service's compute callback against a
// given "existing" row and echo the computed values back as a persisted row.
const withExisting = (existing: UserProfile | undefined) => {
  mockRepo.upsertProfileWithLock.mockImplementation(async (_userId, compute) =>
    profileRow(compute(existing) as Partial<UserProfile>),
  );
};

describe("UserProfileService", () => {
  let service: UserProfileService;

  beforeEach(() => {
    service = new UserProfileService(mockRepo);
  });

  describe("getProfile", () => {
    it("returns unpersisted defaults flagged onboarded:false", async () => {
      mockRepo.findByUserId.mockResolvedValue(undefined as never);

      const result = await service.getProfile(user);

      expect(result.onboarded).toBe(false);
      expect(result.primarySport).toBe("windsurf");
      expect(result.cardSlots).toEqual([
        "distance",
        "time_on_water",
        "best_5x10",
        "sessions",
      ]);
    });

    it("returns a persisted profile flagged onboarded:true", async () => {
      mockRepo.findByUserId.mockResolvedValue(
        profileRow({ primarySport: "sailing" }),
      );

      const result = await service.getProfile(user);

      expect(result.onboarded).toBe(true);
      expect(result.primarySport).toBe("sailing");
    });
  });

  describe("updateProfile", () => {
    it("derives default card slots for a fresh profile by sport", async () => {
      withExisting(undefined);

      const result = await service.updateProfile(user, {
        primarySport: "sailing",
        goal: "track_sessions",
      });

      expect(result.onboarded).toBe(true);
      expect(result.cardSlots).toEqual([
        "distance",
        "time_on_water",
        "avg_speed",
        "sessions",
      ]);
    });

    it("recomputes default slots when the goal changes and none are pinned", async () => {
      withExisting(profileRow());

      const result = await service.updateProfile(user, {
        goal: "improve_technique",
      });

      expect(result.cardSlots).toEqual([
        "time_on_water",
        "moving_time",
        "best_5x10",
        "sessions",
      ]);
    });

    it("respects explicitly-pinned card slots", async () => {
      withExisting(profileRow());

      const result = await service.updateProfile(user, {
        goal: "improve_technique",
        cardSlots: ["max_speed", "avg_speed", "distance", "sessions"],
      });

      expect(result.cardSlots).toEqual([
        "max_speed",
        "avg_speed",
        "distance",
        "sessions",
      ]);
    });

    it("persists an explicit null activityFilter (All Sports)", async () => {
      withExisting(profileRow({ activityFilter: "windsurf" }));

      const result = await service.updateProfile(user, {
        activityFilter: null,
      });

      expect(result.activityFilter).toBeNull();
    });
  });

  describe("sport profiles", () => {
    it("derives effective slots for a non-primary sport override", async () => {
      mockRepo.findByUserId.mockResolvedValue(profileRow());
      mockRepo.listSportProfilesByUserId.mockResolvedValue([sportRow()]);

      const [result] = await service.getSportProfiles(user);

      expect(result.sport).toBe("sup");
      expect(result.cardSlots).toEqual([
        "distance",
        "moving_time",
        "avg_pace",
        "sessions",
      ]);
    });

    it("uses the profile's slots for the primary sport (single source of truth)", async () => {
      mockRepo.findByUserId.mockResolvedValue(
        profileRow({
          primarySport: "windsurf",
          cardSlots: ["max_speed", "avg_speed", "distance", "sessions"],
        }),
      );
      mockRepo.listSportProfilesByUserId.mockResolvedValue([
        sportRow({ sport: "windsurf", cardSlots: null }),
      ]);

      const [result] = await service.getSportProfiles(user);

      // Not the derived windsurf defaults — the user's customized profile slots.
      expect(result.cardSlots).toEqual([
        "max_speed",
        "avg_speed",
        "distance",
        "sessions",
      ]);
    });

    it("full-replaces an override, clearing omitted fields", async () => {
      mockRepo.findByUserId.mockResolvedValue(profileRow());
      mockRepo.upsertSportProfile.mockImplementation(
        async (_userId, sport, values) =>
          sportRow({ sport, ...(values as Partial<UserSportProfile>) }),
      );

      await service.upsertSportProfile(user, "sup", { foilingThresholdMps: 8 });

      // planing threshold not sent → cleared to null (PUT semantics).
      expect(mockRepo.upsertSportProfile).toHaveBeenCalledWith(1, "sup", {
        cardSlots: null,
        planingThresholdMps: null,
        foilingThresholdMps: 8,
        prefs: null,
      });
    });
  });
});
