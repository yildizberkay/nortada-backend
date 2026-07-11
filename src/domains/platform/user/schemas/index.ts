import { z } from "zod";

import {
  activityPeriodEnum,
  analyticsFocusEnum,
  distanceUnitEnum,
  experienceLevelEnum,
  mainGoalEnum,
  sportEnum,
  summaryMetricEnum,
  temperatureUnitEnum,
  windUnitEnum,
} from "@/db/schema";

// Zod enums derive their values from the Drizzle pgEnums so the vocabulary has
// a single source of truth (importing the enum values, not DB operators).
const sport = z.enum(sportEnum.enumValues);
const summaryMetric = z.enum(summaryMetricEnum.enumValues);

// ── Requests ──────────────────────────────────────────────────────────────────

// PATCH /me/profile — every field optional (partial update / upsert). Onboarding
// sends the full set on first call.
export const updateProfileSchema = z
  .object({
    primarySport: sport,
    sports: z.array(sport).min(1),
    experience: z.enum(experienceLevelEnum.enumValues),
    goal: z.enum(mainGoalEnum.enumValues),
    focus: z.enum(analyticsFocusEnum.enumValues),
    activityFilter: sport.nullable(),
    cardSlots: z.array(summaryMetric).length(4),
    defaultActivityPeriod: z.enum(activityPeriodEnum.enumValues),
    windUnit: z.enum(windUnitEnum.enumValues),
    distanceUnit: z.enum(distanceUnitEnum.enumValues),
    temperatureUnit: z.enum(temperatureUnitEnum.enumValues),
  })
  .partial();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const sportParamSchema = z.object({
  sport: z.enum(sportEnum.enumValues),
});

// PUT /me/sport-profiles/:sport — full replacement (idempotent). Omitted fields
// clear the override (→ null). `prefs` is an open per-sport bag (e.g.
// planingThresholdMps / foilingThresholdMps in canonical SI m/s).
export const upsertSportProfileSchema = z.object({
  cardSlots: z.array(summaryMetric).length(4).nullable().optional(),
  prefs: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type UpsertSportProfileInput = z.infer<typeof upsertSportProfileSchema>;

// ── Responses ─────────────────────────────────────────────────────────────────

export const profileResponseSchema = z
  .object({
    // false → this is the (unpersisted) default; the user hasn't onboarded yet,
    // so consumers must not treat the units/sport as deliberate preferences.
    onboarded: z.boolean(),
    primarySport: sport,
    sports: z.array(sport),
    experience: z.enum(experienceLevelEnum.enumValues),
    goal: z.enum(mainGoalEnum.enumValues),
    focus: z.enum(analyticsFocusEnum.enumValues),
    activityFilter: sport.nullable(),
    cardSlots: z.array(summaryMetric),
    defaultActivityPeriod: z.enum(activityPeriodEnum.enumValues),
    windUnit: z.enum(windUnitEnum.enumValues),
    distanceUnit: z.enum(distanceUnitEnum.enumValues),
    temperatureUnit: z.enum(temperatureUnitEnum.enumValues),
  })
  .describe("The user's global personalization profile")
  .meta({ ref: "UserProfileResponse" });
export type ProfileResponse = z.infer<typeof profileResponseSchema>;

export const sportProfileResponseSchema = z
  .object({
    sport,
    // Effective slots: per-sport override → primary-sport slots → derived defaults.
    cardSlots: z.array(summaryMetric),
    // Open per-sport tuning bag (planing/foiling thresholds, etc.), or null.
    prefs: z.record(z.string(), z.unknown()).nullable(),
  })
  .describe("Per-sport profile override (effective)")
  .meta({ ref: "SportProfileResponse" });
export type SportProfileResponse = z.infer<typeof sportProfileResponseSchema>;

export const sportProfileListResponseSchema = z
  .object({
    sportProfiles: z.array(sportProfileResponseSchema),
  })
  .describe("Per-sport profile overrides")
  .meta({ ref: "SportProfileListResponse" });
