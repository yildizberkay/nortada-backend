import { z } from "zod";

import {
  compassDirectionEnum,
  sportEnum,
  spotSkillEnum,
  spotStatusEnum,
  waterTypeEnum,
} from "@/db/schema";

const sport = z.enum(sportEnum.enumValues);
const compass = z.enum(compassDirectionEnum.enumValues);

// ── Requests ──────────────────────────────────────────────────────────────────

export const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(500).default(50),
  sport: sport.optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;

export const searchQuerySchema = z.object({
  q: z.string().min(2).max(100),
  sport: sport.optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const spotUidParamSchema = z.object({ uid: z.string().uuid() });

// User-suggested spot — lands as status=pending for admin moderation.
export const suggestSpotSchema = z.object({
  name: z.string().min(2).max(200),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  country: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  locality: z.string().max(100).optional(),
  waterType: z.enum(waterTypeEnum.enumValues).optional(),
  supportedSports: z.array(sport).min(1),
  // Local knowledge is exactly what a suggester has — stored on the same
  // curated columns; moderation can refine before publishing.
  goodWindDirections: z.array(compass).max(16).optional(),
  riskyWindDirections: z.array(compass).max(16).optional(),
  // Moderator-facing free text ("launch is behind the pier…"). Never echoed
  // in public responses.
  notes: z.string().max(500).optional(),
});
export type SuggestSpotInput = z.infer<typeof suggestSpotSchema>;

export const adminSpotQuerySchema = z.object({
  status: z.enum(spotStatusEnum.enumValues).default("pending"),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

// Admin: enqueue an OSM ingest for a country (ISO 3166-1 alpha-2, e.g. "TR").
export const ingestSpotsSchema = z.object({
  isoCountryCode: z
    .string()
    .length(2)
    .transform((s) => s.toUpperCase()),
});

export const ingestResponseSchema = z
  .object({ taskId: z.string() })
  .describe("The enqueued ingest task id")
  .meta({ ref: "SpotIngestResponse" });

// Admin moderation — publish/reject + curate fields.
export const moderateSpotSchema = z.object({
  status: z.enum(spotStatusEnum.enumValues).optional(),
  name: z.string().min(2).max(200).optional(),
  country: z.string().max(100).nullable().optional(),
  region: z.string().max(100).nullable().optional(),
  locality: z.string().max(100).nullable().optional(),
  waterType: z.enum(waterTypeEnum.enumValues).nullable().optional(),
  skillSuitability: z.enum(spotSkillEnum.enumValues).nullable().optional(),
  supportedSports: z.array(sport).min(1).optional(),
  shoreBearingDeg: z.number().min(0).max(360).nullable().optional(),
  goodWindDirections: z.array(compass).nullable().optional(),
  riskyWindDirections: z.array(compass).nullable().optional(),
  hazards: z.array(z.string().max(60)).nullable().optional(),
});
export type ModerateSpotInput = z.infer<typeof moderateSpotSchema>;

export const favoriteSpotSchema = z.object({
  spotUid: z.string().uuid(),
});

export const favoriteUidParamSchema = z.object({
  spotUid: z.string().uuid(),
});

// ── Responses ─────────────────────────────────────────────────────────────────

export const spotResponseSchema = z
  .object({
    uid: z.string(),
    name: z.string(),
    country: z.string().nullable(),
    region: z.string().nullable(),
    locality: z.string().nullable(),
    latitude: z.number(),
    longitude: z.number(),
    waterType: z.enum(waterTypeEnum.enumValues).nullable(),
    supportedSports: z.array(sport),
    skillSuitability: z.enum(spotSkillEnum.enumValues).nullable(),
    shoreBearingDeg: z.number().nullable(),
    goodWindDirections: z.array(compass).nullable(),
    riskyWindDirections: z.array(compass).nullable(),
    hazards: z.array(z.string()).nullable(),
    status: z.enum(spotStatusEnum.enumValues),
  })
  .describe("A watersports spot")
  .meta({ ref: "SpotResponse" });

// Nearby adds the great-circle distance from the query point.
export const nearbySpotResponseSchema = z
  .object({
    spots: z.array(spotResponseSchema.extend({ distanceKm: z.number() })),
  })
  .describe("Spots near a point, nearest first")
  .meta({ ref: "NearbySpotResponse" });

export const spotListResponseSchema = z
  .object({ spots: z.array(spotResponseSchema) })
  .describe("A list of spots")
  .meta({ ref: "SpotListResponse" });

// The moderation queue is the ONE surface that carries the suggester's note —
// public spot responses must never leak moderator-facing text.
export const adminSpotListResponseSchema = z
  .object({
    spots: z.array(
      spotResponseSchema.extend({ suggestionNotes: z.string().nullable() }),
    ),
  })
  .describe("Spots for moderation, with the suggester's note")
  .meta({ ref: "AdminSpotListResponse" });
export type AdminSpotListResponse = z.infer<typeof adminSpotListResponseSchema>;
