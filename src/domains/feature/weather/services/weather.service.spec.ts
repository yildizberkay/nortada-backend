import type { WeatherCache } from "@/db";
import type { SpotGeo } from "@/domains/feature/spot/types";
import { GenericError } from "@/packages/error";
import type {
  ForecastPayload,
  MarinePayload,
  WeatherProvider,
} from "@/packages/open-meteo";

import type { WeatherRepository } from "../repositories/weather.repository";
import { WeatherService, type WeatherSpotPort } from "./weather.service";

const geo: SpotGeo = {
  uid: "spot-1",
  latitude: 38.27,
  longitude: 26.37,
  shoreBearingDeg: 270,
  supportedSports: ["windsurf", "wingfoil"],
};

const forecastPayload = (currentWind: number): ForecastPayload => ({
  utcOffsetSeconds: 10_800, // UTC+3 — the Aegean beachhead
  current: {
    time: "2026-07-11T12:00:00Z",
    windSpeedMs: currentWind,
    windGustsMs: currentWind + 2,
    windDirectionDeg: 270,
    weatherCode: 0,
    temperatureC: 24,
  },
  daily: {
    date: ["2026-07-11"],
    sunrise: ["2026-07-11T02:47:00Z"],
    sunset: ["2026-07-11T17:39:00Z"],
  },
  hourly: {
    time: ["2026-07-11T12:00:00Z", "2026-07-11T13:00:00Z"],
    windSpeedMs: [currentWind, currentWind],
    windGustsMs: [currentWind + 2, currentWind + 2],
    windDirectionDeg: [270, 270],
    weatherCode: [0, 0],
    temperatureC: [24, 24],
    apparentTemperatureC: [24, 24],
    precipitationMm: [0, 0],
    precipitationProbability: [10, 10],
    capeJkg: [0, 0],
    cloudCover: [10, 10],
  },
});

const marinePayload = (): MarinePayload => ({
  hourly: {
    time: ["2026-07-11T12:00"],
    waveHeightM: [0.4],
    wavePeriodS: [4],
    waveDirectionDeg: [270],
    seaSurfaceTemperatureC: [22],
    seaLevelHeightMslM: [0.1],
  },
});

const mockSpotService = {
  getGeoByUid: jest.fn(),
  listHotSpotGeos: jest.fn(),
} as unknown as jest.Mocked<WeatherSpotPort>;

const mockClient = {
  fetchForecast: jest.fn(),
  fetchMarine: jest.fn(),
  fetchModelMeta: jest.fn(),
} as unknown as jest.Mocked<WeatherProvider>;

const mockRepo = {
  findCache: jest.fn(),
  upsertCache: jest.fn(),
  findModelMeta: jest.fn(),
  upsertModelMeta: jest.fn(),
} as unknown as jest.Mocked<WeatherRepository>;

describe("WeatherService", () => {
  let service: WeatherService;

  beforeEach(() => {
    service = new WeatherService(mockRepo, mockClient, mockSpotService);
    mockSpotService.getGeoByUid.mockResolvedValue(geo);
    mockClient.fetchForecast.mockResolvedValue(forecastPayload(10));
    mockClient.fetchMarine.mockResolvedValue(marinePayload());
    mockRepo.upsertCache.mockResolvedValue(undefined);
  });

  describe("getConditions", () => {
    it("fetches on cache miss and computes the verdict", async () => {
      mockRepo.findCache.mockResolvedValue(undefined as never);

      const result = await service.getConditions("spot-1", {});

      expect(result.sport).toBe("windsurf");
      expect(result.decision).toBe("go"); // 10 m/s windsurf
      expect(result.current.windSide).toBe("onshore"); // dir 270 vs shore 270
      expect(result.freshness.stale).toBe(false);
      expect(mockClient.fetchForecast).toHaveBeenCalledWith(38.27, 26.37);
      expect(mockRepo.upsertCache).toHaveBeenCalled();
    });

    it("serves a fresh cache without hitting Open-Meteo", async () => {
      const fresh: WeatherCache = {
        id: 1,
        uid: "wc",
        spotUid: "spot-1",
        kind: "forecast",
        fetchedAt: new Date(),
        modelRun: null,
        payload: forecastPayload(10) as never,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockRepo.findCache.mockImplementation(async (_uid, kind) =>
        kind === "forecast" ? fresh : (undefined as never),
      );

      await service.getConditions("spot-1", {});

      expect(mockClient.fetchForecast).not.toHaveBeenCalled();
    });

    it("rejects a sport the spot doesn't support", async () => {
      await expect(
        service.getConditions("spot-1", { sport: "kitesurf" }),
      ).rejects.toMatchObject({ errorCode: "FORM_ERROR" });
    });

    it("serves stale cache when the fetch fails", async () => {
      const expired: WeatherCache = {
        id: 1,
        uid: "wc",
        spotUid: "spot-1",
        kind: "forecast",
        fetchedAt: new Date(Date.now() - 7_200_000),
        modelRun: null,
        payload: forecastPayload(10) as never,
        expiresAt: new Date(Date.now() - 3_600_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockRepo.findCache.mockImplementation(async (_uid, kind) =>
        kind === "forecast" ? expired : (undefined as never),
      );
      mockClient.fetchForecast.mockRejectedValue(new Error("open-meteo down"));

      const result = await service.getConditions("spot-1", {});

      expect(result.freshness.stale).toBe(true);
      expect(result.decision).toBe("go");
    });
  });

  describe("getForecast", () => {
    it("rolls hourly up into enriched local-day dailies", async () => {
      mockRepo.findCache.mockResolvedValue(undefined as never);
      const payload = forecastPayload(10);
      // Two hours straddling UTC midnight: at UTC+3 BOTH land on July 12 local.
      payload.hourly.time = ["2026-07-11T22:00:00Z", "2026-07-11T23:00:00Z"];
      payload.hourly.windSpeedMs = [7, 10];
      payload.hourly.windGustsMs = [9, 13];
      payload.hourly.windDirectionDeg = [350, 10];
      payload.daily = {
        date: ["2026-07-12"],
        sunrise: ["2026-07-12T02:48:00Z"],
        sunset: ["2026-07-12T17:38:00Z"],
      };
      mockClient.fetchForecast.mockResolvedValue(payload);

      const result = await service.getForecast("spot-1", {});

      expect(result.utcOffsetSeconds).toBe(10_800);
      expect(result.daily).toHaveLength(1);
      const day = result.daily[0];
      expect(day.date).toBe("2026-07-12"); // local day, not the UTC 07-11
      expect(day.minWindMs).toBe(7);
      expect(day.maxWindMs).toBe(10);
      expect(day.maxGustMs).toBe(13);
      // Circular mean of 350° and 10° is ~0°, never the arithmetic 180°.
      expect(
        Math.min(day.dominantDirectionDeg, 360 - day.dominantDirectionDeg),
      ).toBeLessThanOrEqual(4);
      expect(day.decision).toBe("go"); // 10 m/s windsurf hour
      expect(day.confidence).toBe("high");
      expect(day.bestWindow).toEqual({
        start: "2026-07-11T22:00:00Z",
        end: "2026-07-11T23:00:00Z",
        peakWindMs: 10,
      });
      expect(day.sunrise).toBe("2026-07-12T02:48:00Z");
      expect(day.sunset).toBe("2026-07-12T17:38:00Z");
    });

    it("refetches when the cached payload predates the daily fields", async () => {
      const {
        daily: _daily,
        utcOffsetSeconds: _off,
        ...legacy
      } = forecastPayload(10);
      const cached: WeatherCache = {
        id: 1,
        uid: "wc",
        spotUid: "spot-1",
        kind: "forecast",
        fetchedAt: new Date(),
        modelRun: null,
        payload: legacy as never,
        expiresAt: new Date(Date.now() + 60_000), // NOT expired — shape is
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockRepo.findCache.mockImplementation(async (_uid, kind) =>
        kind === "forecast" ? cached : (undefined as never),
      );

      const result = await service.getForecast("spot-1", {});

      expect(mockClient.fetchForecast).toHaveBeenCalled();
      expect(result.utcOffsetSeconds).toBe(10_800);
    });
  });

  describe("getConditionsBatch", () => {
    it("returns conditions per spot and omits failures", async () => {
      mockRepo.findCache.mockResolvedValue(undefined as never);
      mockSpotService.getGeoByUid.mockImplementation(async (uid) => {
        if (uid === "spot-missing") throw new Error("not found");
        return { ...geo, uid };
      });

      const result = await service.getConditionsBatch(
        ["spot-1", "spot-missing", "spot-2", "spot-1"],
        {},
      );

      expect(result.spots.map((s) => s.spotUid)).toEqual(["spot-1", "spot-2"]);
    });
  });

  describe("refreshHotSet", () => {
    it("refreshes every hot spot and tolerates one failure", async () => {
      mockSpotService.listHotSpotGeos.mockResolvedValue([
        geo,
        { ...geo, uid: "spot-2" },
      ]);
      mockRepo.findCache.mockResolvedValue(undefined as never);
      mockClient.fetchForecast
        .mockResolvedValueOnce(forecastPayload(10))
        .mockRejectedValueOnce(new Error("fail"));

      const result = await service.refreshHotSet();

      expect(result.hotSpots).toBe(2);
      expect(result.refreshed).toBe(1);
      expect(result.failures).toEqual([
        { spotUid: "spot-2", providerStatus: null, error: "Error: fail" },
      ]);
    });

    it("reports the provider HTTP status for non-OK failures", async () => {
      mockSpotService.listHotSpotGeos.mockResolvedValue([geo]);
      mockRepo.findCache.mockResolvedValue(undefined as never);
      mockClient.fetchForecast.mockRejectedValueOnce(
        new GenericError("EXTERNAL_SERVICE_ERROR", {
          message: "Weather provider returned 404",
          data: { status: 404, url: "https://api.open-meteo.com/v1/forecast" },
        }),
      );

      const result = await service.refreshHotSet();

      expect(result.refreshed).toBe(0);
      expect(result.failures).toEqual([
        {
          spotUid: "spot-1",
          providerStatus: 404,
          error: expect.stringContaining("404"),
        },
      ]);
    });

    it("returns an empty failure report when every spot refreshes", async () => {
      mockSpotService.listHotSpotGeos.mockResolvedValue([geo]);
      mockRepo.findCache.mockResolvedValue(undefined as never);

      const result = await service.refreshHotSet();

      expect(result.refreshed).toBe(1);
      expect(result.failures).toEqual([]);
    });
  });
});
