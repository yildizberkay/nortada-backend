import { globalConfig } from "@/app/global-config";
import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";

const logger = createLogger("open-meteo");

// Canonical SI values (D-006). The request pins wind_speed_unit=ms /
// temperature_unit=celsius, so the response is already SI. Times are requested
// as unixtime with timezone=auto — epochs are timezone-independent (we emit
// them as canonical UTC ISO strings) while `utc_offset_seconds` still tells the
// client the spot's local offset, and the daily block splits on LOCAL days
// (sunrise/sunset belong to the spot's calendar day, not the UTC one).

export interface ForecastCurrent {
  time: string;
  windSpeedMs: number;
  windGustsMs: number;
  windDirectionDeg: number;
  weatherCode: number;
  temperatureC: number;
}

export interface ForecastHourly {
  time: string[];
  windSpeedMs: number[];
  windGustsMs: number[];
  windDirectionDeg: number[];
  weatherCode: number[];
  temperatureC: number[];
  apparentTemperatureC: number[];
  precipitationMm: number[];
  precipitationProbability: number[];
  capeJkg: number[];
  cloudCover: number[];
}

export interface ForecastDaily {
  /** Spot-local calendar dates (YYYY-MM-DD). */
  date: string[];
  /** ISO-8601 UTC. */
  sunrise: string[];
  sunset: string[];
}

export interface ForecastPayload {
  /** The spot's local UTC offset — clients shift the UTC times for display. */
  utcOffsetSeconds: number;
  current: ForecastCurrent;
  hourly: ForecastHourly;
  daily: ForecastDaily;
}

export interface MarineHourly {
  time: string[];
  waveHeightM: number[];
  wavePeriodS: number[];
  waveDirectionDeg: number[];
  seaSurfaceTemperatureC: number[];
  seaLevelHeightMslM: number[];
}

export interface MarinePayload {
  hourly: MarineHourly;
}

export interface ModelMeta {
  lastRunAvailabilityTime: Date | null;
  updateIntervalSec: number | null;
}

/**
 * Weather provider contract. `WeatherService` depends on this, not on a concrete
 * client, so a second source (METAR/buoys/another model API) can be swapped in
 * behind the same interface. Payloads are canonical SI. `OpenMeteoClient` is the
 * first implementation.
 */
export interface WeatherProvider {
  fetchForecast(lat: number, lon: number): Promise<ForecastPayload>;
  fetchMarine(lat: number, lon: number): Promise<MarinePayload>;
  fetchModelMeta(model: string): Promise<ModelMeta>;
}

const FORECAST_HOURLY = [
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
  "weather_code",
  "temperature_2m",
  "apparent_temperature",
  "precipitation",
  "precipitation_probability",
  "cape",
  "cloud_cover",
].join(",");

const FORECAST_CURRENT = [
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
  "weather_code",
  "temperature_2m",
].join(",");

// Pin the model so the served payload matches the model-metadata we read for
// the freshness/stale signal (a bare best_match would resolve per-location and
// make the "updated Xm ago / model run" story inconsistent). `icon_seamless` is
// ICON global+EU stitched — solid for the Aegean beachhead. See otonom-kararlar.
export const FORECAST_MODEL = "icon_seamless";
// The composite `icon_seamless` has NO meta.json of its own (verified
// 2026-07-16: /data/icon_seamless/... → 404), so run-freshness metadata comes
// from its member models, most-relevant first: ICON-EU drives our spots'
// near-term hours (Europe incl. the Aegean, 3 h cadence); ICON global fills
// the long tail (6 h cadence).
export const FORECAST_MODEL_META_SOURCES = ["dwd_icon_eu", "dwd_icon"];
// Display-ready provenance for client attribution footnotes — lives NEXT TO
// the pinned model so a model switch can't leave the label behind.
export const FORECAST_SOURCE_DISPLAY = "Open-Meteo";
export const FORECAST_MODEL_DISPLAY = "ICON";

const FORECAST_DAILY = ["sunrise", "sunset"].join(",");

const MARINE_HOURLY = [
  "wave_height",
  "wave_period",
  "wave_direction",
  "sea_surface_temperature",
  "sea_level_height_msl",
].join(",");

// Raw JSON from an external API — validated defensively below.
type Json = any;

const nums = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "number" ? x : Number(x))) : [];
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

// Unixtime seconds → canonical UTC ISO ("2026-07-14T16:00:00Z").
const isoUtc = (sec: unknown): string =>
  typeof sec === "number"
    ? `${new Date(sec * 1000).toISOString().slice(0, 19)}Z`
    : "";
const isoUtcAll = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(isoUtc) : [];
// Local-midnight epoch + offset → the LOCAL calendar date it labels.
const localDate = (sec: unknown, offsetSec: number): string =>
  typeof sec === "number"
    ? new Date((sec + offsetSec) * 1000).toISOString().slice(0, 10)
    : "";

async function getJson(url: string): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    logger.error("Open-Meteo request failed", { error: String(error) });
    throw new GenericError("EXTERNAL_SERVICE_ERROR", {
      message: "Weather provider request failed",
    });
  }
  if (!response.ok) {
    logger.error("Open-Meteo non-OK", { status: response.status, url });
    throw new GenericError("EXTERNAL_SERVICE_ERROR", {
      message: `Weather provider returned ${response.status}`,
      data: { status: response.status, url },
    });
  }
  return response.json();
}

/**
 * Thin Open-Meteo client. Reads endpoints from config lazily (import-safe).
 * External HTTP → lives in packages/, not a domain repository.
 */
export class OpenMeteoClient implements WeatherProvider {
  async fetchForecast(lat: number, lon: number): Promise<ForecastPayload> {
    const base = globalConfig.config.openMeteo.forecastUrl;
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      hourly: FORECAST_HOURLY,
      current: FORECAST_CURRENT,
      daily: FORECAST_DAILY,
      models: FORECAST_MODEL,
      wind_speed_unit: "ms",
      temperature_unit: "celsius",
      precipitation_unit: "mm",
      // Epochs are absolute, so the payload stays canonical-UTC (D-006) while
      // `auto` still yields the spot's utc_offset_seconds and local-day dailies.
      timezone: "auto",
      timeformat: "unixtime",
      cell_selection: "sea",
      forecast_days: "11",
    });
    const data = await getJson(`${base}/forecast?${params.toString()}`);
    const c = data.current ?? {};
    const h = data.hourly ?? {};
    const d = data.daily ?? {};
    const offsetSec = Number(data.utc_offset_seconds ?? 0);
    return {
      utcOffsetSeconds: offsetSec,
      current: {
        time: isoUtc(c.time),
        windSpeedMs: Number(c.wind_speed_10m ?? 0),
        windGustsMs: Number(c.wind_gusts_10m ?? 0),
        windDirectionDeg: Number(c.wind_direction_10m ?? 0),
        weatherCode: Number(c.weather_code ?? 0),
        temperatureC: Number(c.temperature_2m ?? 0),
      },
      daily: {
        date: Array.isArray(d.time)
          ? d.time.map((t: unknown) => localDate(t, offsetSec))
          : [],
        sunrise: isoUtcAll(d.sunrise),
        sunset: isoUtcAll(d.sunset),
      },
      hourly: {
        time: isoUtcAll(h.time),
        windSpeedMs: nums(h.wind_speed_10m),
        windGustsMs: nums(h.wind_gusts_10m),
        windDirectionDeg: nums(h.wind_direction_10m),
        weatherCode: nums(h.weather_code),
        temperatureC: nums(h.temperature_2m),
        apparentTemperatureC: nums(h.apparent_temperature),
        precipitationMm: nums(h.precipitation),
        precipitationProbability: nums(h.precipitation_probability),
        capeJkg: nums(h.cape),
        cloudCover: nums(h.cloud_cover),
      },
    };
  }

  async fetchMarine(lat: number, lon: number): Promise<MarinePayload> {
    const base = globalConfig.config.openMeteo.marineUrl;
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      hourly: MARINE_HOURLY,
      timezone: "UTC",
      forecast_days: "11",
    });
    const data = await getJson(`${base}/marine?${params.toString()}`);
    const h = data.hourly ?? {};
    return {
      hourly: {
        time: strs(h.time),
        waveHeightM: nums(h.wave_height),
        wavePeriodS: nums(h.wave_period),
        waveDirectionDeg: nums(h.wave_direction),
        seaSurfaceTemperatureC: nums(h.sea_surface_temperature),
        seaLevelHeightMslM: nums(h.sea_level_height_msl),
      },
    };
  }

  async fetchModelMeta(model: string): Promise<ModelMeta> {
    // Per-model static metadata lives at the API ORIGIN (/data/<model>/
    // static/meta.json), not under /v1 — there is no /v1/model-metadata
    // endpoint (it 404s; the old path broke every cron run until
    // 2026-07-16). Only concrete models have a meta file; composites like
    // `icon_seamless` do not (callers pass FORECAST_MODEL_META_SOURCES).
    const origin = new URL(globalConfig.config.openMeteo.forecastUrl).origin;
    const data = await getJson(
      `${origin}/data/${encodeURIComponent(model)}/static/meta.json`,
    );
    // Times are unix seconds.
    const avail = data.last_run_availability_time;
    return {
      lastRunAvailabilityTime:
        typeof avail === "number" ? new Date(avail * 1000) : null,
      updateIntervalSec:
        typeof data.update_interval_seconds === "number"
          ? data.update_interval_seconds
          : null,
    };
  }
}
