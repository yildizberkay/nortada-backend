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

// Comma-separated spot uids for the batch endpoint — the map viewport asks for
// its visible markers in one round-trip.
export const batchConditionsQuerySchema = z.object({
  uids: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((uid) => uid.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().uuid()).min(1).max(50)),
  sport: sport.optional(),
});
export type BatchConditionsQuery = z.infer<typeof batchConditionsQuerySchema>;

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
    // All times in this contract are UTC; shift by this for spot-local display.
    utcOffsetSeconds: z.number(),
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

// One spot-LOCAL calendar day, sized for the client's 10-day outlook strip.
const forecastDaySchema = z.object({
  date: z.string(),
  minWindMs: z.number(),
  maxWindMs: z.number(),
  maxGustMs: z.number(),
  // Speed-weighted circular mean of the day's wind directions.
  dominantDirectionDeg: z.number(),
  decision,
  confidence,
  bestWindow: bestWindowSchema,
  sunrise: z.iso.datetime().nullable(),
  sunset: z.iso.datetime().nullable(),
});

export const forecastResponseSchema = z
  .object({
    spotUid: z.string(),
    sport,
    // All times in this contract are UTC; shift by this for spot-local display.
    utcOffsetSeconds: z.number(),
    hourly: z.array(forecastHourSchema),
    daily: z.array(forecastDaySchema),
    freshness: freshnessSchema,
  })
  .describe("Hourly + daily forecast strip for a spot")
  .meta({ ref: "ForecastResponse" });

export const batchConditionsResponseSchema = z
  .object({
    spots: z.array(conditionsResponseSchema),
  })
  .describe(
    "Conditions for a batch of spots; spots that could not be resolved are omitted",
  )
  .meta({ ref: "BatchConditionsResponse" });
