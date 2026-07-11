import type { NewActivityEffort } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";

import { ActivityReason } from "../errors";
import { ALGORITHM_VERSION, computeMetrics, type Sample } from "../metrics";
import type { ActivityRepository } from "../repositories/activity.repository";

const log = createLogger("ActivityMetricsService");

/**
 * Canonical metric computation (D-001), invoked by the activity-compute-metrics
 * Trigger task. Reads the immutable L0 track, computes L1 derived summary /
 * route / efforts, and flips the activity to `ready` (or `failed`). Idempotent
 * and re-runnable when ALGORITHM_VERSION bumps.
 */
export class ActivityMetricsService extends BaseUseCase {
  constructor(private readonly activityRepository: ActivityRepository) {
    super();
  }

  async computeAndStore(activityUid: string): Promise<void> {
    const activity = await this.activityRepository.findByUid(activityUid);
    if (!activity) {
      throw new GenericError("NOT_FOUND", {
        reason: ActivityReason.NOT_FOUND,
        message: "Activity not found",
      });
    }

    try {
      const track = await this.activityRepository.findTrackByActivityId(
        activity.id,
      );
      const samples = (track?.samples ?? []) as unknown as Sample[];
      const { summary, efforts, polyline } = computeMetrics(samples);
      const computedAt = new Date();

      await this.activityRepository.upsertSummary({
        activityId: activity.id,
        ...summary,
        algorithmVersion: ALGORITHM_VERSION,
        inputDataVersion: activity.dataVersion,
        computedAt,
      });

      await this.activityRepository.upsertRoute({
        activityId: activity.id,
        polyline,
        algorithmVersion: ALGORITHM_VERSION,
        computedAt,
      });

      const effortRows: NewActivityEffort[] = efforts.map((e) => ({
        activityId: activity.id,
        type: e.type as NewActivityEffort["type"],
        resultMs: e.resultMs,
        durationSec: e.durationSec ?? null,
        distanceM: e.distanceM ?? null,
        startOffsetSec: e.startOffsetSec ?? null,
        algorithmVersion: ALGORITHM_VERSION,
        computedAt,
      }));
      await this.activityRepository.replaceEfforts(activity.id, effortRows);

      await this.activityRepository.setStatus(activity.id, "ready");
      log.info("Activity metrics computed", {
        activityUid,
        efforts: effortRows.length,
      });
    } catch (error) {
      await this.activityRepository.setStatus(activity.id, "failed");
      throw error;
    }
  }
}
