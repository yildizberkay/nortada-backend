import type { SpotResponse } from "@/domains/feature/spot/services/spot.service";

import {
  type BriefingConditions,
  type BriefingFavoritePort,
  type BriefingProfilePort,
  BriefingService,
  type BriefingSpotPort,
  type BriefingWeatherPort,
} from "./briefing.service";

const spot = (uid: string, over: Partial<SpotResponse> = {}): SpotResponse => ({
  uid,
  name: uid,
  country: "Turkey",
  region: "İstanbul",
  locality: "Kadıköy",
  latitude: 40.95,
  longitude: 29.05,
  waterType: "sea",
  supportedSports: ["windsurf", "sup"],
  skillSuitability: "all",
  shoreBearingDeg: 180,
  goodWindDirections: null,
  riskyWindDirections: null,
  hazards: null,
  status: "published",
  ...over,
});

type ConditionsOverride = Partial<Omit<BriefingConditions, "current">> & {
  current?: Partial<BriefingConditions["current"]>;
};

const conditions = (
  spotUid: string,
  over: ConditionsOverride = {},
): BriefingConditions => ({
  spotUid,
  sport: "windsurf",
  utcOffsetSeconds: 10_800,
  decision: "go",
  confidence: "high",
  bestWindow: null,
  sea: null,
  freshness: {
    fetchedAt: "2026-07-14T12:00:00.000Z",
    modelRun: null,
    stale: false,
  },
  ...over,
  current: {
    time: "2026-07-14T12:00:00Z",
    windSpeedMs: 9,
    windGustsMs: 11,
    windDirectionDeg: 180,
    weatherCode: 1,
    temperatureC: 24,
    windSide: "onshore",
    ...(over.current ?? {}),
  },
});

const mockFavorites = { list: jest.fn() } as jest.Mocked<BriefingFavoritePort>;
const mockSpots = { nearby: jest.fn() } as jest.Mocked<BriefingSpotPort>;
const mockProfile = {
  getProfile: jest.fn(),
} as jest.Mocked<BriefingProfilePort>;
const mockWeather = {
  getConditions: jest.fn(),
} as jest.Mocked<BriefingWeatherPort>;

const user = { id: 1 };

describe("BriefingService", () => {
  let service: BriefingService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new BriefingService(
      mockFavorites,
      mockSpots,
      mockProfile,
      mockWeather,
    );
    mockProfile.getProfile.mockResolvedValue({ primarySport: "windsurf" });
  });

  it("ranks go above watch and returns state goodNow with reasons", async () => {
    mockFavorites.list.mockResolvedValue([spot("watchy"), spot("goody")]);
    mockWeather.getConditions.mockImplementation(async (uid) =>
      uid === "goody"
        ? conditions(uid)
        : conditions(uid, { decision: "watch" }),
    );

    const result = await service.getBriefing(user, {});

    expect(result.state).toBe("goodNow");
    expect(result.pick?.spot.uid).toBe("goody");
    expect(result.pick?.reasons).toEqual([
      "wind_in_ideal_band",
      "onshore",
      "steady_wind",
      "fresh_data",
    ]);
    expect(result.alternatives.map((a) => a.spot.uid)).toEqual(["watchy"]);
  });

  it("breaks watch ties by the soonest best window → goodLater", async () => {
    mockFavorites.list.mockResolvedValue([spot("late"), spot("soon")]);
    const watch = {
      decision: "watch" as const,
      current: { windSpeedMs: 5.5, windGustsMs: 7, windDirectionDeg: 180 },
    };
    mockWeather.getConditions.mockImplementation(async (uid) =>
      conditions(uid, {
        ...watch,
        bestWindow: {
          start:
            uid === "soon" ? "2026-07-14T15:00:00Z" : "2026-07-15T09:00:00Z",
          end: "2026-07-15T12:00:00Z",
          peakWindMs: 9,
        },
      }),
    );

    const result = await service.getBriefing(user, {});

    expect(result.pick?.spot.uid).toBe("soon");
    expect(result.state).toBe("goodLater");
  });

  it("stale dominates the state machine", async () => {
    mockFavorites.list.mockResolvedValue([spot("s1")]);
    mockWeather.getConditions.mockResolvedValue(
      conditions("s1", {
        freshness: { fetchedAt: "…", modelRun: null, stale: true },
      }),
    );

    const result = await service.getBriefing(user, {});

    expect(result.state).toBe("stale");
    expect(result.pick?.reasons).toContain("stale_data");
  });

  it("flags risky for a watch verdict with a safety reason", async () => {
    mockFavorites.list.mockResolvedValue([spot("gusty")]);
    mockWeather.getConditions.mockResolvedValue(
      conditions("gusty", {
        decision: "watch",
        current: {
          time: "2026-07-14T12:00:00Z",
          windSpeedMs: 9,
          windGustsMs: 19, // > windsurf ceiling → gusts_overpowering
          windDirectionDeg: 180,
          weatherCode: 1,
          temperatureC: 24,
          windSide: "onshore",
        },
      }),
    );

    const result = await service.getBriefing(user, {});

    expect(result.state).toBe("risky");
    expect(result.pick?.reasons).toContain("gusts_overpowering");
  });

  it("drops candidates whose conditions fail instead of failing the briefing", async () => {
    mockFavorites.list.mockResolvedValue([spot("broken"), spot("ok")]);
    mockWeather.getConditions.mockImplementation(async (uid) => {
      if (uid === "broken") throw new Error("provider down");
      return conditions(uid);
    });

    const result = await service.getBriefing(user, {});

    expect(result.pick?.spot.uid).toBe("ok");
    expect(result.alternatives).toHaveLength(0);
  });

  it("filters favorites that don't support the briefed sport", async () => {
    mockFavorites.list.mockResolvedValue([
      spot("sup-only", { supportedSports: ["sup"] }),
    ]);

    const result = await service.getBriefing(user, {});

    expect(result.state).toBe("noSpots");
    expect(result.pick).toBeNull();
    expect(mockWeather.getConditions).not.toHaveBeenCalled();
  });

  it("falls back to nearby spots (with distance) when there are no favorites", async () => {
    mockFavorites.list.mockResolvedValue([]);
    mockSpots.nearby.mockResolvedValue([{ ...spot("near"), distanceKm: 4.2 }]);
    mockWeather.getConditions.mockResolvedValue(conditions("near"));

    const result = await service.getBriefing(user, { lat: 40.9, lon: 29.0 });

    expect(mockSpots.nearby).toHaveBeenCalledWith({
      lat: 40.9,
      lon: 29.0,
      radiusKm: 50,
      limit: 5,
    });
    expect(result.pick?.spot.distanceKm).toBe(4.2);
    expect(result.state).toBe("goodNow");
  });

  it("returns noSpots without location when the user has no favorites", async () => {
    mockFavorites.list.mockResolvedValue([]);

    const result = await service.getBriefing(user, {});

    expect(result.state).toBe("noSpots");
    expect(mockSpots.nearby).not.toHaveBeenCalled();
  });

  it("uses the profile's primary sport when none is queried", async () => {
    mockProfile.getProfile.mockResolvedValue({ primarySport: "sup" });
    mockFavorites.list.mockResolvedValue([spot("s1")]);
    mockWeather.getConditions.mockResolvedValue(
      conditions("s1", { sport: "sup" }),
    );

    const result = await service.getBriefing(user, {});

    expect(result.sport).toBe("sup");
    expect(mockWeather.getConditions).toHaveBeenCalledWith("s1", {
      sport: "sup",
    });
  });
});
