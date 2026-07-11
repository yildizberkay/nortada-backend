import type { JsonValue } from "@/db";
import type { SpotService } from "@/domains/feature/spot/services/spot.service";
import type { SpotGeo } from "@/domains/feature/spot/types";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import { windSide } from "@/packages/geo";
import { createLogger } from "@/packages/logger";
import type {
  ForecastPayload,
  MarinePayload,
  OpenMeteoClient,
} from "@/packages/open-meteo";

import {
  bestWindow,
  computeConfidence,
  computeDecision,
  type Decision,
} from "../decision";
import { WeatherReason } from "../errors";
import type { WeatherRepository } from "../repositories/weather.repository";
import type { WeatherQuery } from "../schemas";

type Sport = SpotGeo["supportedSports"][number];

const FORECAST_TTL_MS = 60 * 60 * 1000; // 1h — the "now" tick wants freshness
const MARINE_TTL_MS = 3 * 60 * 60 * 1000; // 3h — waves move slower
const DEFAULT_MODEL = "icon_seamless";

const log = createLogger("WeatherService");

interface Fetched<T> {
  payload: T;
  fetchedAt: Date;
  modelRun: Date | null;
  stale: boolean;
}

export class WeatherService extends BaseUseCase {
  constructor(
    private readonly weatherRepository: WeatherRepository,
    private readonly openMeteoClient: OpenMeteoClient,
    private readonly spotService: SpotService,
  ) {
    super();
  }

  async getConditions(spotUid: string, query: WeatherQuery) {
    const spot = await this.spotService.getGeoByUid(spotUid);
    const sport = this.resolveSport(spot, query.sport);

    const fc = await this.getOrFetchForecast(spot);
    const forecast = fc.payload;
    const marine = await this.getOrFetchMarine(spot).catch(() => null);

    const current = forecast.current;
    const side =
      spot.shoreBearingDeg != null
        ? windSide(spot.shoreBearingDeg, current.windDirectionDeg)
        : null;

    const decision = computeDecision({
      sport,
      windMs: current.windSpeedMs,
      gustMs: current.windGustsMs,
      weatherCode: current.weatherCode,
      windDirectionDeg: current.windDirectionDeg,
      shoreBearingDeg: spot.shoreBearingDeg,
    });

    const confidence = computeConfidence({
      stale: fc.stale,
      gustSpreadMs: current.windGustsMs - current.windSpeedMs,
      precipitationProbability:
        forecast.hourly.precipitationProbability[0] ?? 0,
    });

    const window = bestWindow(forecast.hourly, sport, spot.shoreBearingDeg);

    return {
      spotUid,
      sport,
      current: { ...current, windSide: side },
      decision,
      confidence,
      bestWindow: window,
      sea: marine
        ? {
            waveHeightM: marine.payload.hourly.waveHeightM[0] ?? null,
            seaSurfaceTemperatureC:
              marine.payload.hourly.seaSurfaceTemperatureC[0] ?? null,
          }
        : null,
      freshness: this.freshness(fc),
    };
  }

  async getForecast(spotUid: string, query: WeatherQuery) {
    const spot = await this.spotService.getGeoByUid(spotUid);
    const sport = this.resolveSport(spot, query.sport);
    const fc = await this.getOrFetchForecast(spot);
    const h = fc.payload.hourly;

    const hourly = h.time.slice(0, 48).map((time, i) => ({
      time,
      windSpeedMs: h.windSpeedMs[i] ?? 0,
      windGustsMs: h.windGustsMs[i] ?? 0,
      windDirectionDeg: h.windDirectionDeg[i] ?? 0,
      weatherCode: h.weatherCode[i] ?? 0,
      temperatureC: h.temperatureC[i] ?? 0,
      decision: computeDecision({
        sport,
        windMs: h.windSpeedMs[i] ?? 0,
        gustMs: h.windGustsMs[i] ?? 0,
        weatherCode: h.weatherCode[i] ?? 0,
        windDirectionDeg: h.windDirectionDeg[i],
        shoreBearingDeg: spot.shoreBearingDeg,
      }),
    }));

    return {
      spotUid,
      sport,
      hourly,
      daily: this.deriveDaily(fc.payload, sport, spot.shoreBearingDeg),
      freshness: this.freshness(fc),
    };
  }

  /** Re-fetch the whole hot set (favorites). Called by the weather-refresh cron
   * (D-004) — one spot's failure never aborts the batch. */
  async refreshHotSet(): Promise<{ hotSpots: number; refreshed: number }> {
    const spots = await this.spotService.listHotSpotGeos();
    let refreshed = 0;
    for (const spot of spots) {
      try {
        await this.fetchAndCacheForecast(spot);
        await this.fetchAndCacheMarine(spot);
        refreshed++;
      } catch (error) {
        log.warn("Hot-set refresh failed for spot", {
          spotUid: spot.uid,
          error: String(error),
        });
      }
    }
    return { hotSpots: spots.length, refreshed };
  }

  async refreshModelMeta(): Promise<void> {
    const meta = await this.openMeteoClient.fetchModelMeta(DEFAULT_MODEL);
    await this.weatherRepository.upsertModelMeta({
      model: DEFAULT_MODEL,
      lastRunAvailabilityTime: meta.lastRunAvailabilityTime,
      updateIntervalSec: meta.updateIntervalSec,
      fetchedAt: new Date(),
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private resolveSport(spot: SpotGeo, requested?: Sport): Sport {
    if (requested) {
      if (!spot.supportedSports.includes(requested)) {
        throw new GenericError("FORM_ERROR", {
          reason: WeatherReason.UNSUPPORTED_SPORT,
          message: "This spot does not support the requested sport",
        });
      }
      return requested;
    }
    return spot.supportedSports[0] ?? "other";
  }

  private freshness(fc: Fetched<unknown>) {
    return {
      fetchedAt: fc.fetchedAt.toISOString(),
      modelRun: fc.modelRun ? fc.modelRun.toISOString() : null,
      stale: fc.stale,
    };
  }

  private async getOrFetchForecast(
    spot: SpotGeo,
  ): Promise<Fetched<ForecastPayload>> {
    const cached = await this.weatherRepository.getCache(spot.uid, "forecast");
    const now = new Date();
    if (cached && cached.expiresAt > now) {
      return {
        payload: cached.payload as unknown as ForecastPayload,
        fetchedAt: cached.fetchedAt,
        modelRun: cached.modelRun,
        stale: false,
      };
    }
    try {
      return await this.fetchAndCacheForecast(spot);
    } catch (error) {
      // Graceful degradation: serve stale cache rather than erroring out.
      if (cached) {
        log.warn("Serving stale forecast after fetch failure", {
          spotUid: spot.uid,
        });
        return {
          payload: cached.payload as unknown as ForecastPayload,
          fetchedAt: cached.fetchedAt,
          modelRun: cached.modelRun,
          stale: true,
        };
      }
      throw error;
    }
  }

  private async fetchAndCacheForecast(
    spot: SpotGeo,
  ): Promise<Fetched<ForecastPayload>> {
    const payload = await this.openMeteoClient.fetchForecast(
      spot.latitude,
      spot.longitude,
    );
    const fetchedAt = new Date();
    await this.weatherRepository.upsertCache({
      spotUid: spot.uid,
      kind: "forecast",
      fetchedAt,
      modelRun: null,
      payload: payload as unknown as JsonValue,
      expiresAt: new Date(fetchedAt.getTime() + FORECAST_TTL_MS),
    });
    return { payload, fetchedAt, modelRun: null, stale: false };
  }

  private async getOrFetchMarine(
    spot: SpotGeo,
  ): Promise<Fetched<MarinePayload>> {
    const cached = await this.weatherRepository.getCache(spot.uid, "marine");
    const now = new Date();
    if (cached && cached.expiresAt > now) {
      return {
        payload: cached.payload as unknown as MarinePayload,
        fetchedAt: cached.fetchedAt,
        modelRun: cached.modelRun,
        stale: false,
      };
    }
    return this.fetchAndCacheMarine(spot);
  }

  private async fetchAndCacheMarine(
    spot: SpotGeo,
  ): Promise<Fetched<MarinePayload>> {
    const payload = await this.openMeteoClient.fetchMarine(
      spot.latitude,
      spot.longitude,
    );
    const fetchedAt = new Date();
    await this.weatherRepository.upsertCache({
      spotUid: spot.uid,
      kind: "marine",
      fetchedAt,
      modelRun: null,
      payload: payload as unknown as JsonValue,
      expiresAt: new Date(fetchedAt.getTime() + MARINE_TTL_MS),
    });
    return { payload, fetchedAt, modelRun: null, stale: false };
  }

  private deriveDaily(
    forecast: ForecastPayload,
    sport: Sport,
    shoreBearingDeg: number | null,
  ): Array<{ date: string; maxWindMs: number; decision: Decision }> {
    const h = forecast.hourly;
    const byDate = new Map<
      string,
      { maxWindMs: number; decisions: Decision[] }
    >();

    for (let i = 0; i < h.time.length; i++) {
      const date = h.time[i].slice(0, 10);
      const entry = byDate.get(date) ?? { maxWindMs: 0, decisions: [] };
      entry.maxWindMs = Math.max(entry.maxWindMs, h.windSpeedMs[i] ?? 0);
      entry.decisions.push(
        computeDecision({
          sport,
          windMs: h.windSpeedMs[i] ?? 0,
          gustMs: h.windGustsMs[i] ?? 0,
          weatherCode: h.weatherCode[i] ?? 0,
          windDirectionDeg: h.windDirectionDeg[i],
          shoreBearingDeg,
        }),
      );
      byDate.set(date, entry);
    }

    // The day's headline = its BEST hour (least-severe decision).
    const rank: Record<Decision, number> = { go: 0, watch: 1, skip: 2 };
    return [...byDate.entries()].map(([date, e]) => ({
      date,
      maxWindMs: e.maxWindMs,
      decision: e.decisions.reduce((best, d) =>
        rank[d] < rank[best] ? d : best,
      ),
    }));
  }
}
