import type {
  Activity,
  ActivityCondition,
  ActivitySummary,
  JsonValue,
  NewActivity,
} from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import type { RequestUser } from "@/types";

import { ActivityReason } from "../errors";
import type {
  ActivityRepository,
  ActivityWithSummary,
} from "../repositories/activity.repository";
import type { EquipmentRepository } from "../repositories/equipment.repository";
import type { CreateActivityInput, PatchActivityInput } from "../schemas";
import { triggerActivityComputeMetrics } from "../tasks/activity-compute-metrics.trigger";

const toSummaryDto = (s: ActivitySummary | null) =>
  s
    ? {
        totalDistanceM: s.totalDistanceM,
        maxSpeedMs: s.maxSpeedMs,
        avgSpeedMs: s.avgSpeedMs,
        avgMovingSpeedMs: s.avgMovingSpeedMs,
        durationSec: s.durationSec,
        movingDurationSec: s.movingDurationSec,
        maxDistanceFromStartM: s.maxDistanceFromStartM,
        validSampleCount: s.validSampleCount,
        gapCount: s.gapCount,
      }
    : null;

const toListItem = (row: ActivityWithSummary) => ({
  uid: row.activity.uid,
  sport: row.activity.sport,
  customName: row.activity.customName,
  status: row.activity.status,
  startedAt: row.activity.startedAt.toISOString(),
  spotName: row.activity.spotName,
  summary: toSummaryDto(row.summary),
});

const toConditionDto = (c: ActivityCondition) => ({
  kind: c.kind,
  windSpeedMs: c.windSpeedMs,
  windGustsMs: c.windGustsMs,
  windDirectionDeg: c.windDirectionDeg,
  temperatureC: c.temperatureC,
  weatherCode: c.weatherCode,
});

export class ActivityService extends BaseUseCase {
  constructor(
    private readonly activityRepository: ActivityRepository,
    private readonly equipmentRepository: EquipmentRepository,
  ) {
    super();
  }

  /**
   * Store an uploaded session (idempotent on the client-generated uid) and
   * enqueue canonical metric computation. A retried upload is a no-op: the
   * activity already exists and its track is already stored.
   */
  async create(user: RequestUser, input: CreateActivityInput) {
    const first = input.samples[0];
    const last = input.samples[input.samples.length - 1];

    const activity = await this.activityRepository.createActivity({
      uid: input.uid,
      userId: user.id,
      sport: input.sport,
      source: input.source,
      status: "processing",
      startedAt: new Date(input.startedAt),
      endedAt: input.endedAt ? new Date(input.endedAt) : null,
      timezone: input.timezone ?? null,
      spotUid: input.spotUid ?? null,
      spotName: input.spotName ?? null,
      startLat: first?.lat ?? null,
      startLon: first?.lon ?? null,
      endLat: last?.lat ?? null,
      endLon: last?.lon ?? null,
      device: input.device ?? null,
      deviceModel: input.deviceModel ?? null,
      osVersion: input.osVersion ?? null,
      appVersion: input.appVersion ?? null,
    });

    // Idempotency guard: only ingest + enqueue when this is a fresh upload.
    const existingTrack = await this.activityRepository.findTrackByActivityId(
      activity.id,
    );
    if (!existingTrack) {
      await this.activityRepository.insertTrack({
        activityId: activity.id,
        sampleCount: input.samples.length,
        samples: input.samples as unknown as JsonValue,
      });

      if (input.conditions) {
        await this.activityRepository.insertConditions([
          {
            activityId: activity.id,
            kind: "forecast",
            windSpeedMs: input.conditions.windSpeedMs ?? null,
            windGustsMs: input.conditions.windGustsMs ?? null,
            windDirectionDeg: input.conditions.windDirectionDeg ?? null,
            temperatureC: input.conditions.temperatureC ?? null,
            weatherCode: input.conditions.weatherCode ?? null,
            capturedAt: new Date(input.startedAt),
          },
        ]);
      }

      if (input.equipment) {
        for (const item of input.equipment) {
          const profile = await this.equipmentRepository.findByUidForUser(
            item.equipmentUid,
            user.id,
          );
          if (profile) {
            await this.activityRepository.insertEquipmentLink({
              activityId: activity.id,
              equipmentProfileId: profile.id,
              role: item.role ?? null,
              snapshot: (profile.attributes ?? null) as JsonValue,
            });
          }
        }
      }

      await triggerActivityComputeMetrics(activity.uid);
    }

    return { uid: activity.uid, status: activity.status };
  }

  async list(
    user: RequestUser,
    query: { sport?: Activity["sport"]; limit: number },
  ) {
    const rows = await this.activityRepository.listByUser(
      user.id,
      query.limit,
      query.sport,
    );
    return { activities: rows.map(toListItem) };
  }

  async detail(user: RequestUser, uid: string) {
    const activity = await this.activityRepository.findByUidForUser(
      uid,
      user.id,
    );
    if (!activity) {
      throw new GenericError("NOT_FOUND", {
        reason: ActivityReason.NOT_FOUND,
        message: "Activity not found",
      });
    }

    const [summary, route, efforts, conditions] = await Promise.all([
      this.activityRepository.findSummaryByActivityId(activity.id),
      this.activityRepository.findRouteByActivityId(activity.id),
      this.activityRepository.findEffortsByActivityId(activity.id),
      this.activityRepository.findConditionsByActivityId(activity.id),
    ]);

    return {
      uid: activity.uid,
      sport: activity.sport,
      customName: activity.customName,
      status: activity.status,
      startedAt: activity.startedAt.toISOString(),
      endedAt: activity.endedAt ? activity.endedAt.toISOString() : null,
      spotUid: activity.spotUid,
      spotName: activity.spotName,
      privacy: activity.privacy,
      notes: activity.notes,
      summary: toSummaryDto(summary ?? null),
      polyline: route?.polyline ?? null,
      efforts: efforts.map((e) => ({
        type: e.type,
        resultMs: e.resultMs,
        durationSec: e.durationSec,
        distanceM: e.distanceM,
      })),
      conditions: conditions.map(toConditionDto),
    };
  }

  async patchContext(
    user: RequestUser,
    uid: string,
    input: PatchActivityInput,
  ): Promise<void> {
    const patch: Partial<NewActivity> = {};
    if (input.customName !== undefined) patch.customName = input.customName;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.feeling !== undefined) patch.feeling = input.feeling;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.perceivedEffort !== undefined) {
      patch.perceivedEffort = input.perceivedEffort;
    }
    if (input.privacy !== undefined) patch.privacy = input.privacy;
    if (input.hideStart !== undefined) patch.hideStart = input.hideStart;
    if (input.hiddenRadiusM !== undefined) {
      patch.hiddenRadiusM = input.hiddenRadiusM;
    }

    const updated = await this.activityRepository.updateContext(
      uid,
      user.id,
      patch,
    );
    if (!updated) {
      throw new GenericError("NOT_FOUND", {
        reason: ActivityReason.NOT_FOUND,
        message: "Activity not found",
      });
    }
  }

  async remove(user: RequestUser, uid: string): Promise<void> {
    const deleted = await this.activityRepository.deleteByUid(uid, user.id);
    if (!deleted) {
      throw new GenericError("NOT_FOUND", {
        reason: ActivityReason.NOT_FOUND,
        message: "Activity not found",
      });
    }
  }
}
