import type { JsonValue } from "@/db";
import type { SpotGeo } from "@/domains/feature/spot/types";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import { windSide } from "@/packages/geo";
import { createLogger } from "@/packages/logger";
import {
  FORECAST_MODEL,
  FORECAST_MODEL_DISPLAY,
  FORECAST_SOURCE_DISPLAY,
  type ForecastPayload,
  type MarinePayload,
  type WeatherProvider,
} from "@/packages/open-meteo";

import {
  type BestWindow,
  bestWindow,
  type Confidence,
  computeConfidence,
  computeDecision,
  type Decision,
  type HourlySeries,
} from "../decision";
import { WeatherReason } from "../errors";
import type { WeatherRepository } from "../repositories/weather.repository";
import type { WeatherQuery } from "../schemas";

type Sport = SpotGeo["supportedSports"][number];

const FORECAST_TTL_MS = 60 * 60 * 1000; // 1h — the "now" tick wants freshness
const MARINE_TTL_MS = 3 * 60 * 60 * 1000; // 3h — waves move slower
// Cold-cache batch items each hit Open-Meteo — keep the fan-out polite.
const BATCH_CONCURRENCY = 6;

const log = createLogger("WeatherService");

interface Fetched<T> {
  payload: T;
  fetchedAt: Date;
  modelRun: Date | null;
  stale: boolean;
}

/** One row of the daily strip — a spot-LOCAL calendar day rolled up from the
 * hourly series, sized for the client's 10-day outlook UI. */
interface ForecastDay {
  date: string;
  minWindMs: number;
  maxWindMs: number;
  maxGustMs: number;
  dominantDirectionDeg: number;
  decision: Decision;
  confidence: Confidence;
  bestWindow: BestWindow | null;
  sunrise: string | null;
  sunset: string | null;
}

/**
 * The minimal slice of the spot domain weather depends on (SOLID ISP/DIP). The
 * spot module's `SpotService` satisfies it; weather never sees the rest of its
 * surface. RFC-0006 (activity→weather) should follow the same port pattern.
 */
export interface WeatherSpotPort {
  getGeoByUid(uid: string): Promise<SpotGeo>;
  listHotSpotGeos(): Promise<SpotGeo[]>;
}

export class WeatherService extends BaseUseCase {
  constructor(
    private readonly weatherRepository: WeatherRepository,
    private readonly weatherProvider: WeatherProvider,
    private readonly spotPort: WeatherSpotPort,
  ) {
    super();
  }

  async getConditions(spotUid: string, query: WeatherQuery) {
    const spot = await this.spotPort.getGeoByUid(spotUid);
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
      // `current` block has no CAPE — use the nearest hour.
      capeJkg: forecast.hourly.capeJkg[0],
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
      utcOffsetSeconds: forecast.utcOffsetSeconds,
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
      freshness: this.freshness(fc, await this.modelMeta()),
    };
  }

  /** Conditions for many spots at once — the map viewport shows a dozen
   * markers and must not pay a round-trip per marker. Spots that fail
   * (unknown uid, unsupported sport, provider error) are omitted rather than
   * failing the batch. */
  async getConditionsBatch(uids: string[], query: WeatherQuery) {
    const unique = [...new Set(uids)];
    const spots: Awaited<ReturnType<WeatherService["getConditions"]>>[] = [];
    for (let i = 0; i < unique.length; i += BATCH_CONCURRENCY) {
      const chunk = unique.slice(i, i + BATCH_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((uid) => this.getConditions(uid, query)),
      );
      for (const [j, result] of results.entries()) {
        if (result.status === "fulfilled") {
          spots.push(result.value);
        } else {
          log.warn("Batch conditions failed for spot", {
            spotUid: chunk[j],
            error: String(result.reason),
          });
        }
      }
    }
    return { spots };
  }

  async getForecast(spotUid: string, query: WeatherQuery) {
    const spot = await this.spotPort.getGeoByUid(spotUid);
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
        capeJkg: h.capeJkg[i],
        windDirectionDeg: h.windDirectionDeg[i],
        shoreBearingDeg: spot.shoreBearingDeg,
      }),
    }));

    const freshness = this.freshness(fc, await this.modelMeta());
    return {
      spotUid,
      sport,
      utcOffsetSeconds: fc.payload.utcOffsetSeconds,
      hourly,
      daily: this.deriveDaily(
        fc.payload,
        sport,
        spot.shoreBearingDeg,
        freshness.stale,
      ),
      freshness,
    };
  }

  /** Re-fetch the whole hot set (favorites). Called by the weather-refresh cron
   * (D-004) — one spot's failure never aborts the batch. */
  async refreshHotSet(): Promise<{ hotSpots: number; refreshed: number }> {
    const spots = await this.spotPort.listHotSpotGeos();
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
    const meta = await this.weatherProvider.fetchModelMeta(FORECAST_MODEL);
    await this.weatherRepository.upsertModelMeta({
      model: FORECAST_MODEL,
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

  /** The pinned model's run time + update cadence (for the "updated Xm ago /
   * stale" story). The forecast is pinned to FORECAST_MODEL so this metadata
   * describes the same model that produced the served payload. */
  private async modelMeta(): Promise<{
    lastRun: Date | null;
    updateIntervalSec: number | null;
  }> {
    const meta = await this.weatherRepository.findModelMeta(FORECAST_MODEL);
    return {
      lastRun: meta?.lastRunAvailabilityTime ?? null,
      updateIntervalSec: meta?.updateIntervalSec ?? null,
    };
  }

  private freshness(
    fc: Fetched<unknown>,
    meta: { lastRun: Date | null; updateIntervalSec: number | null },
  ) {
    // Stale when the provider fetch failed (fc.stale), OR our copy has aged past
    // the model's update interval (mapping doc §3).
    const agedOut =
      meta.updateIntervalSec != null &&
      Date.now() - fc.fetchedAt.getTime() > meta.updateIntervalSec * 1000;
    return {
      fetchedAt: fc.fetchedAt.toISOString(),
      modelRun: meta.lastRun ? meta.lastRun.toISOString() : null,
      stale: fc.stale || agedOut,
      // Provenance rides every response so client attribution footnotes can
      // never drift from the model actually served (RFC-0005).
      source: FORECAST_SOURCE_DISPLAY,
      model: FORECAST_MODEL_DISPLAY,
    };
  }

  /** Cached rows written before the daily/utcOffsetSeconds fields existed
   * can't serve the current contract — treat them as absent so they refetch. */
  private isCurrentForecastShape(payload: unknown): boolean {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "daily" in payload &&
      "utcOffsetSeconds" in payload
    );
  }

  private async getOrFetchForecast(
    spot: SpotGeo,
  ): Promise<Fetched<ForecastPayload>> {
    const found = await this.weatherRepository.findCache(spot.uid, "forecast");
    const cached =
      found && this.isCurrentForecastShape(found.payload) ? found : undefined;
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
    const payload = await this.weatherProvider.fetchForecast(
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
    const cached = await this.weatherRepository.findCache(spot.uid, "marine");
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
    const payload = await this.weatherProvider.fetchMarine(
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
    stale: boolean,
  ): ForecastDay[] {
    const h = forecast.hourly;
    const offsetMs = forecast.utcOffsetSeconds * 1000;

    // Group hour indices by the spot's LOCAL calendar day — that is the day
    // the client's outlook strip renders (a 21:00 local go-window must not
    // leak into the next day just because it crossed UTC midnight).
    const byDate = new Map<string, number[]>();
    for (let i = 0; i < h.time.length; i++) {
      const date = new Date(Date.parse(h.time[i]) + offsetMs)
        .toISOString()
        .slice(0, 10);
      const indices = byDate.get(date) ?? [];
      indices.push(i);
      byDate.set(date, indices);
    }

    const sun = new Map(
      forecast.daily.date.map((date, i) => [
        date,
        {
          sunrise: forecast.daily.sunrise[i] || null,
          sunset: forecast.daily.sunset[i] || null,
        },
      ]),
    );

    const rank: Record<Decision, number> = { go: 0, watch: 1, skip: 2 };
    return [...byDate.entries()].map(([date, indices]) => {
      let minWindMs = Number.POSITIVE_INFINITY;
      let maxWindMs = 0;
      let maxGustMs = 0;
      let maxGustSpreadMs = 0;
      let maxPrecipitationProbability = 0;
      // Speed-weighted circular mean — a plain average of degrees breaks at
      // the 350°/10° wrap.
      let east = 0;
      let north = 0;
      let decision: Decision = "skip";

      for (const i of indices) {
        const windMs = h.windSpeedMs[i] ?? 0;
        const gustMs = h.windGustsMs[i] ?? 0;
        minWindMs = Math.min(minWindMs, windMs);
        maxWindMs = Math.max(maxWindMs, windMs);
        maxGustMs = Math.max(maxGustMs, gustMs);
        maxGustSpreadMs = Math.max(maxGustSpreadMs, gustMs - windMs);
        maxPrecipitationProbability = Math.max(
          maxPrecipitationProbability,
          h.precipitationProbability[i] ?? 0,
        );
        const rad = ((h.windDirectionDeg[i] ?? 0) * Math.PI) / 180;
        east += windMs * Math.sin(rad);
        north += windMs * Math.cos(rad);
        // The day's headline = its BEST hour (least-severe decision).
        const hourDecision = computeDecision({
          sport,
          windMs,
          gustMs,
          weatherCode: h.weatherCode[i] ?? 0,
          capeJkg: h.capeJkg[i],
          windDirectionDeg: h.windDirectionDeg[i],
          shoreBearingDeg,
        });
        if (rank[hourDecision] < rank[decision]) decision = hourDecision;
      }

      const daySeries: HourlySeries = {
        time: indices.map((i) => h.time[i]),
        windSpeedMs: indices.map((i) => h.windSpeedMs[i] ?? 0),
        windGustsMs: indices.map((i) => h.windGustsMs[i] ?? 0),
        windDirectionDeg: indices.map((i) => h.windDirectionDeg[i] ?? 0),
        weatherCode: indices.map((i) => h.weatherCode[i] ?? 0),
        capeJkg: indices.map((i) => h.capeJkg[i] ?? 0),
      };

      return {
        date,
        minWindMs: Number.isFinite(minWindMs) ? minWindMs : 0,
        maxWindMs,
        maxGustMs,
        dominantDirectionDeg:
          east || north
            ? Math.round((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
            : 0,
        decision,
        confidence: computeConfidence({
          stale,
          gustSpreadMs: maxGustSpreadMs,
          precipitationProbability: maxPrecipitationProbability,
        }),
        bestWindow: bestWindow(
          daySeries,
          sport,
          shoreBearingDeg,
          indices.length,
        ),
        sunrise: sun.get(date)?.sunrise ?? null,
        sunset: sun.get(date)?.sunset ?? null,
      };
    });
  }
}
