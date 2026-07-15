import { z } from "zod";

import {
  activityPrivacyEnum,
  activitySourceEnum,
  effortTypeEnum,
  equipmentTypeEnum,
  sportEnum,
} from "@/db/schema";

const sport = z.enum(sportEnum.enumValues);
const privacy = z.enum(activityPrivacyEnum.enumValues);

// ── Upload (POST /v1/activities, gzip body) ───────────────────────────────────

const sampleSchema = z.object({
  t: z.number(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  speed: z.number().min(0).optional(),
  hAccuracy: z.number().min(0).optional(),
  // CoreLocation speedAccuracy (m/s); < 0 means the Doppler speed is invalid.
  sAccuracy: z.number().optional(),
});

// Forecast snapshot the app already showed the user (observed obs is a later
// phase — activity-data-model.md).
const conditionsSchema = z.object({
  windSpeedMs: z.number().optional(),
  windGustsMs: z.number().optional(),
  windDirectionDeg: z.number().optional(),
  temperatureC: z.number().optional(),
  weatherCode: z.number().int().optional(),
});

export const createActivitySchema = z.object({
  // Client-generated → idempotent upload (a retried upload is a no-op).
  uid: z.string().uuid(),
  sport,
  source: z.enum(activitySourceEnum.enumValues).default("iphone"),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  timezone: z.string().max(64).optional(),
  spotUid: z.string().uuid().optional(),
  spotName: z.string().max(200).optional(),
  device: z.string().max(120).optional(),
  deviceModel: z.string().max(120).optional(),
  osVersion: z.string().max(60).optional(),
  appVersion: z.string().max(60).optional(),
  samples: z.array(sampleSchema).max(200_000),
  conditions: conditionsSchema.optional(),
  equipment: z
    .array(
      z.object({
        equipmentUid: z.string().uuid(),
        role: z.string().max(60).optional(),
      }),
    )
    .max(20)
    .optional(),
});
export type CreateActivityInput = z.infer<typeof createActivitySchema>;

// ── Other requests ────────────────────────────────────────────────────────────

export const activityUidParamSchema = z.object({ uid: z.string().uuid() });

export const listActivitiesQuerySchema = z.object({
  sport: sport.optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export const patchActivitySchema = z.object({
  customName: z.string().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  feeling: z.string().max(60).nullable().optional(),
  tags: z.array(z.string().max(40)).nullable().optional(),
  perceivedEffort: z.number().int().min(1).max(10).nullable().optional(),
  privacy: privacy.optional(),
  hideStart: z.boolean().optional(),
  hiddenRadiusM: z.number().positive().nullable().optional(),
});
export type PatchActivityInput = z.infer<typeof patchActivitySchema>;

export const equipmentUidParamSchema = z.object({ uid: z.string().uuid() });

export const createEquipmentSchema = z.object({
  type: z.enum(equipmentTypeEnum.enumValues),
  name: z.string().min(1).max(120),
  attributes: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type CreateEquipmentInput = z.infer<typeof createEquipmentSchema>;

// ── Responses ─────────────────────────────────────────────────────────────────

const summarySchema = z
  .object({
    totalDistanceM: z.number(),
    maxSpeedMs: z.number(),
    avgSpeedMs: z.number(),
    avgMovingSpeedMs: z.number(),
    durationSec: z.number(),
    movingDurationSec: z.number(),
    maxDistanceFromStartM: z.number().nullable(),
    validSampleCount: z.number(),
    gapCount: z.number(),
  })
  .nullable();

export const activityListItemSchema = z.object({
  uid: z.string(),
  sport,
  customName: z.string().nullable(),
  status: z.string(),
  startedAt: z.iso.datetime(),
  spotName: z.string().nullable(),
  summary: summarySchema,
});

export const activityListResponseSchema = z
  .object({ activities: z.array(activityListItemSchema) })
  .describe("A list of the user's activities")
  .meta({ ref: "ActivityListResponse" });

const effortSchema = z.object({
  type: z.enum(effortTypeEnum.enumValues),
  resultMs: z.number(),
  durationSec: z.number().nullable(),
  distanceM: z.number().nullable(),
});

export const activityDetailResponseSchema = z
  .object({
    uid: z.string(),
    sport,
    customName: z.string().nullable(),
    status: z.string(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    spotUid: z.string().nullable(),
    spotName: z.string().nullable(),
    privacy,
    notes: z.string().nullable(),
    summary: summarySchema,
    polyline: z.string().nullable(),
    efforts: z.array(effortSchema),
    conditions: z
      .array(
        z.object({
          kind: z.string(),
          windSpeedMs: z.number().nullable(),
          windGustsMs: z.number().nullable(),
          windDirectionDeg: z.number().nullable(),
          temperatureC: z.number().nullable(),
          weatherCode: z.number().nullable(),
        }),
      )
      .default([]),
  })
  .describe("Full activity detail")
  .meta({ ref: "ActivityDetailResponse" });

export const equipmentResponseSchema = z
  .object({
    uid: z.string(),
    type: z.enum(equipmentTypeEnum.enumValues),
    name: z.string(),
    attributes: z.record(z.string(), z.unknown()).nullable(),
  })
  .describe("An equipment profile")
  .meta({ ref: "EquipmentResponse" });

export const equipmentListResponseSchema = z
  .object({ equipment: z.array(equipmentResponseSchema) })
  .describe("The user's equipment library")
  .meta({ ref: "EquipmentListResponse" });

export const createActivityResponseSchema = z
  .object({ uid: z.string(), status: z.string() })
  .describe("Created activity id + status")
  .meta({ ref: "CreateActivityResponse" });
