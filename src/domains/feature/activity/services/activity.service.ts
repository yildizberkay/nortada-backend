import { promisify } from "node:util";
import { gzip } from "node:zlib";

import type {
  Activity,
  ActivityCondition,
  ActivitySummary,
  JsonValue,
  NewActivity,
  NewActivityCondition,
  NewActivityEquipment,
} from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";
import type { ObjectStorage } from "@/packages/object-storage";
import type { RequestUser } from "@/types";

import { ActivityReason } from "../errors";
import type {
  ActivityRepository,
  ActivityWithSummary,
} from "../repositories/activity.repository";
import type { EquipmentRepository } from "../repositories/equipment.repository";
import type { CreateActivityInput, PatchActivityInput } from "../schemas";
import { triggerActivityComputeMetrics } from "../tasks/activity-compute-metrics.trigger";

const log = createLogger("ActivityService");
const gzipAsync = promisify(gzip);

/** S3 key for an activity's immutable raw track. Deterministic from the uid, so
 * a re-upload overwrites the same object (idempotent). */
const trackStorageKey = (activityUid: string) =>
  `activities/${activityUid}/track.json.gz`;

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
    private readonly objectStorage: ObjectStorage,
  ) {
    super();
  }

  /**
   * Store an uploaded session (idempotent on the client-generated uid) and
   * enqueue canonical metric computation. A retried upload never re-ingests the
   * immutable L0 track, but WILL re-enqueue compute while the activity is still
   * `processing` — so an upload whose enqueue previously failed recovers instead
   * of stranding forever.
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

    // Ownership guard: the client-generated uid collided with a DIFFERENT user's
    // activity. Never mutate another user's aggregate — refuse (409). Reads are
    // already user-scoped; this closes the write-side IDOR.
    if (activity.userId !== user.id) {
      throw new GenericError("ALREADY_EXISTS", {
        reason: ActivityReason.ALREADY_EXISTS,
        message: "An activity with this id already exists",
      });
    }

    // Idempotency: ingest the immutable L0 track exactly once. `trackExists` is a
    // cheap probe that never pulls the samples blob.
    const alreadyIngested = await this.activityRepository.trackExists(
      activity.id,
    );
    if (!alreadyIngested) {
      const conditions: NewActivityCondition[] = input.conditions
        ? [
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
          ]
        : [];

      const equipmentLinks = await this.resolveEquipmentLinks(
        user.id,
        activity.id,
        input.equipment,
      );

      // Store the immutable raw track in object storage (gzipped JSON) BEFORE the
      // DB write — external I/O must not sit inside the DB transaction. The key is
      // deterministic, so a retry overwrites the same object; a rare orphan (S3
      // written, DB not) is reclaimed by the next retry.
      const storageKey = trackStorageKey(activity.uid);
      const body = await gzipAsync(Buffer.from(JSON.stringify(input.samples)));
      await this.objectStorage.put(storageKey, body, {
        contentType: "application/json",
        contentEncoding: "gzip",
      });

      await this.activityRepository.ingestTrack({
        track: {
          activityId: activity.id,
          sampleCount: input.samples.length,
          storageKey,
        },
        conditions,
        equipmentLinks,
      });
    }

    // Enqueue keyed on status (NOT on track existence), so a retry after a failed
    // enqueue re-enqueues. `computeAndStore` is idempotent, so a rare double
    // enqueue (concurrent uploads) is harmless; a `failed` activity is left alone
    // (re-uploading the same immutable track can't change the outcome).
    if (activity.status === "processing") {
      await triggerActivityComputeMetrics(activity.uid);
    }

    return { uid: activity.uid, status: activity.status };
  }

  /** Resolve the upload's equipment refs to owned profiles. An unresolved ref is
   * skipped (best-effort attach never fails the session upload) but logged so the
   * drop is observable. */
  private async resolveEquipmentLinks(
    userId: number,
    activityId: number,
    equipment: CreateActivityInput["equipment"],
  ): Promise<NewActivityEquipment[]> {
    if (!equipment) return [];
    const links: NewActivityEquipment[] = [];
    for (const item of equipment) {
      const profile = await this.equipmentRepository.findByUidForUser(
        item.equipmentUid,
        userId,
      );
      if (profile) {
        links.push({
          activityId,
          equipmentProfileId: profile.id,
          role: item.role ?? null,
          snapshot: (profile.attributes ?? null) as JsonValue,
        });
      } else {
        log.warn("Skipped unresolved equipment ref on upload", {
          activityId,
          equipmentUid: item.equipmentUid,
        });
      }
    }
    return links;
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
