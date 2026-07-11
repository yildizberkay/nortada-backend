import { z } from "zod";

import { sportEnum } from "@/db/schema";

const sport = z.enum(sportEnum.enumValues);
const decision = z.enum(["go", "watch", "skip"]);
const confidence = z.enum(["low", "medium", "high"]);
const windSide = z.enum([
  "onshore",
  "cross-onshore",
  "cross-shore",
  "cross-offshore",
  "offshore",
]);

// ── Requests ──────────────────────────────────────────────────────────────────

export const spotUidParamSchema = z.object({ uid: z.string().uuid() });

// Optional sport context; defaults to the spot's first supported sport.
export const weatherQuerySchema = z.object({
  sport: sport.optional(),
});
export type WeatherQuery = z.infer<typeof weatherQuerySchema>;

// ── Responses ─────────────────────────────────────────────────────────────────

const freshnessSchema = z.object({
  fetchedAt: z.iso.datetime(),
  modelRun: z.iso.datetime().nullable(),
  stale: z.boolean(),
});

const bestWindowSchema = z
  .object({
    start: z.string(),
    end: z.string(),
    peakWindMs: z.number(),
  })
  .nullable();

export const conditionsResponseSchema = z
  .object({
    spotUid: z.string(),
    sport,
    current: z.object({
      time: z.string(),
      windSpeedMs: z.number(),
      windGustsMs: z.number(),
      windDirectionDeg: z.number(),
      weatherCode: z.number(),
      temperatureC: z.number(),
      windSide: windSide.nullable(),
    }),
    decision,
    confidence,
    bestWindow: bestWindowSchema,
    sea: z
      .object({
        waveHeightM: z.number().nullable(),
        seaSurfaceTemperatureC: z.number().nullable(),
      })
      .nullable(),
    freshness: freshnessSchema,
  })
  .describe("Now-cast conditions + verdict for a spot")
  .meta({ ref: "ConditionsResponse" });

const forecastHourSchema = z.object({
  time: z.string(),
  windSpeedMs: z.number(),
  windGustsMs: z.number(),
  windDirectionDeg: z.number(),
  weatherCode: z.number(),
  temperatureC: z.number(),
  decision,
});

const forecastDaySchema = z.object({
  date: z.string(),
  maxWindMs: z.number(),
  decision,
});

export const forecastResponseSchema = z
  .object({
    spotUid: z.string(),
    sport,
    hourly: z.array(forecastHourSchema),
    daily: z.array(forecastDaySchema),
    freshness: freshnessSchema,
  })
  .describe("Hourly + daily forecast strip for a spot")
  .meta({ ref: "ForecastResponse" });
