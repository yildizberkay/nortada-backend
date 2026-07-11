import type { WeatherCache } from "@/db";
import type { SpotService } from "@/domains/feature/spot/services/spot.service";
import type { SpotGeo } from "@/domains/feature/spot/types";
import type {
  ForecastPayload,
  MarinePayload,
  OpenMeteoClient,
} from "@/packages/open-meteo";

import type { WeatherRepository } from "../repositories/weather.repository";
import { WeatherService } from "./weather.service";

const geo: SpotGeo = {
  uid: "spot-1",
  latitude: 38.27,
  longitude: 26.37,
  shoreBearingDeg: 270,
  supportedSports: ["windsurf", "wingfoil"],
};

const forecastPayload = (currentWind: number): ForecastPayload => ({
  current: {
    time: "2026-07-11T12:00",
    windSpeedMs: currentWind,
    windGustsMs: currentWind + 2,
    windDirectionDeg: 270,
    weatherCode: 0,
    temperatureC: 24,
  },
  hourly: {
    time: ["2026-07-11T12:00", "2026-07-11T13:00"],
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
} as unknown as jest.Mocked<SpotService>;

const mockClient = {
  fetchForecast: jest.fn(),
  fetchMarine: jest.fn(),
  fetchModelMeta: jest.fn(),
} as unknown as jest.Mocked<OpenMeteoClient>;

const mockRepo = {
  getCache: jest.fn(),
  upsertCache: jest.fn(),
  getModelMeta: jest.fn(),
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
      mockRepo.getCache.mockResolvedValue(undefined as never);

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
      mockRepo.getCache.mockImplementation(async (_uid, kind) =>
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
      mockRepo.getCache.mockImplementation(async (_uid, kind) =>
        kind === "forecast" ? expired : (undefined as never),
      );
      mockClient.fetchForecast.mockRejectedValue(new Error("open-meteo down"));

      const result = await service.getConditions("spot-1", {});

      expect(result.freshness.stale).toBe(true);
      expect(result.decision).toBe("go");
    });
  });

  describe("refreshHotSet", () => {
    it("refreshes every hot spot and tolerates one failure", async () => {
      mockSpotService.listHotSpotGeos.mockResolvedValue([
        geo,
        { ...geo, uid: "spot-2" },
      ]);
      mockRepo.getCache.mockResolvedValue(undefined as never);
      mockClient.fetchForecast
        .mockResolvedValueOnce(forecastPayload(10))
        .mockRejectedValueOnce(new Error("fail"));

      const result = await service.refreshHotSet();

      expect(result.hotSpots).toBe(2);
      expect(result.refreshed).toBe(1);
    });
  });
});
