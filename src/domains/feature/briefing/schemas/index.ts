import { z } from "zod";

import { sportEnum, waterTypeEnum } from "@/db/schema";
import { conditionsResponseSchema } from "@/domains/feature/weather/schemas";

const sport = z.enum(sportEnum.enumValues);

// ── Requests ──────────────────────────────────────────────────────────────────

// lat/lon travel together: they enable the no-favorites nearby fallback and
// distanceKm on every briefed spot.
export const briefingQuerySchema = z
  .object({
    sport: sport.optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lon: z.coerce.number().min(-180).max(180).optional(),
  })
  .refine((q) => (q.lat == null) === (q.lon == null), {
    message: "lat and lon must be provided together",
  });
export type BriefingQuery = z.infer<typeof briefingQuerySchema>;

// ── Responses ─────────────────────────────────────────────────────────────────

export const briefingStates = [
  "goodNow",
  "goodLater",
  "risky",
  "noGoodWindow",
  "lowConfidence",
  "stale",
  "noSpots",
] as const;

const decisionReason = z.enum([
  "wind_in_ideal_band",
  "wind_below_ideal",
  "wind_above_ideal",
  "too_light",
  "too_strong",
  "onshore",
  "cross_onshore",
  "cross_shore",
  "cross_offshore_caution",
  "offshore_risk",
  "steady_wind",
  "gusty",
  "gusts_overpowering",
  "storm_risk",
  "heavy_precipitation",
  "stale_data",
  "fresh_data",
]);

// The compact spot slice the Today screen renders — not the full SpotResponse
// (no curation/status fields across this boundary). Named refs so generated
// clients get ONE reusable type for the pick and every alternative.
const briefingSpotSchema = z
  .object({
    uid: z.string(),
    name: z.string(),
    locality: z.string().nullable(),
    region: z.string().nullable(),
    country: z.string().nullable(),
    latitude: z.number(),
    longitude: z.number(),
    waterType: z.enum(waterTypeEnum.enumValues).nullable(),
    supportedSports: z.array(sport),
    shoreBearingDeg: z.number().nullable(),
    distanceKm: z.number().nullable(),
  })
  .describe("The compact spot slice the briefing renders")
  .meta({ ref: "BriefingSpot" });

const briefingCandidateSchema = z
  .object({
    spot: briefingSpotSchema,
    conditions: conditionsResponseSchema,
  })
  .describe("A briefed spot with its now-cast conditions")
  .meta({ ref: "BriefingCandidate" });

export const briefingResponseSchema = z
  .object({
    state: z.enum(briefingStates),
    sport,
    pick: briefingCandidateSchema
      .extend({ reasons: z.array(decisionReason) })
      .nullable(),
    alternatives: z.array(briefingCandidateSchema),
  })
  .describe(
    "The Today briefing: one ranked top pick with decision reasons, up to three alternatives, and the state the client keys its layout on",
  )
  .meta({ ref: "BriefingResponse" });
