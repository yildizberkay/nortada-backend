import type { Activity } from "@/db";
import type { RequestUser } from "@/types";

import { ActivityReason } from "../errors";
import type { ActivityRepository } from "../repositories/activity.repository";
import type { EquipmentRepository } from "../repositories/equipment.repository";
import { triggerActivityComputeMetrics } from "../tasks/activity-compute-metrics.trigger";
import { ActivityService } from "./activity.service";

jest.mock("../tasks/activity-compute-metrics.trigger", () => ({
  triggerActivityComputeMetrics: jest.fn(),
}));
const mockTrigger = triggerActivityComputeMetrics as jest.MockedFunction<
  typeof triggerActivityComputeMetrics
>;

const user: RequestUser = {
  id: 1,
  uid: "u1",
  isAnonymous: false,
  clerkUserId: "c1",
  isAdmin: false,
};

const activityRow = (overrides: Partial<Activity> = {}): Activity =>
  ({
    id: 10,
    uid: "act-1",
    userId: 1,
    sport: "windsurf",
    customName: null,
    status: "processing",
    source: "iphone",
    dataVersion: 1,
    startedAt: new Date("2026-07-11T09:00:00Z"),
    endedAt: null,
    spotUid: null,
    spotName: null,
    privacy: "private",
    notes: null,
    ...overrides,
  }) as Activity;

const uploadInput = {
  uid: "act-1",
  sport: "windsurf" as const,
  source: "iphone" as const,
  startedAt: "2026-07-11T09:00:00Z",
  samples: [
    { t: 0, lat: 38, lon: 26 },
    { t: 1, lat: 38.001, lon: 26 },
  ],
};

const mockRepo = {
  createActivity: jest.fn(),
  findByUid: jest.fn(),
  findByUidForUser: jest.fn(),
  listByUser: jest.fn(),
  updateContext: jest.fn(),
  deleteByUid: jest.fn(),
  trackExists: jest.fn(),
  ingestTrack: jest.fn(),
  findSummaryByActivityId: jest.fn(),
  findRouteByActivityId: jest.fn(),
  findEffortsByActivityId: jest.fn(),
  findConditionsByActivityId: jest.fn(),
} as unknown as jest.Mocked<ActivityRepository>;

const mockEquipmentRepo = {
  findByUidForUser: jest.fn(),
} as unknown as jest.Mocked<EquipmentRepository>;

const mockObjectStorage = {
  put: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
};

describe("ActivityService", () => {
  let service: ActivityService;

  beforeEach(() => {
    service = new ActivityService(
      mockRepo,
      mockEquipmentRepo,
      mockObjectStorage,
    );
  });

  describe("create", () => {
    it("ingests a fresh upload and enqueues metric computation", async () => {
      mockRepo.createActivity.mockResolvedValue(activityRow());
      mockRepo.trackExists.mockResolvedValue(false);

      const result = await service.create(user, {
        ...uploadInput,
        markers: [61, 12.5],
      });

      // The Mark-button offsets land on the activity row itself, sorted —
      // readers assume time order and the client contract doesn't promise it.
      expect(mockRepo.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ markers: [12.5, 61] }),
      );

      // Raw track goes to object storage; the DB row keeps only the key + count.
      expect(mockObjectStorage.put).toHaveBeenCalledWith(
        "activities/act-1/track.json.gz",
        expect.any(Buffer),
        expect.objectContaining({ contentEncoding: "gzip" }),
      );
      expect(mockRepo.ingestTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          track: expect.objectContaining({
            activityId: 10,
            sampleCount: 2,
            storageKey: "activities/act-1/track.json.gz",
          }),
        }),
      );
      expect(mockTrigger).toHaveBeenCalledWith("act-1");
      expect(result).toEqual({ uid: "act-1", status: "processing" });
    });

    it("does not re-ingest or re-enqueue a retry once metrics are ready", async () => {
      mockRepo.createActivity.mockResolvedValue(
        activityRow({ status: "ready" }),
      );
      mockRepo.trackExists.mockResolvedValue(true);

      await service.create(user, uploadInput);

      // A marker-less upload persists an honest null, not [].
      expect(mockRepo.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ markers: null }),
      );
      expect(mockObjectStorage.put).not.toHaveBeenCalled();
      expect(mockRepo.ingestTrack).not.toHaveBeenCalled();
      expect(mockTrigger).not.toHaveBeenCalled();
    });

    it("re-enqueues a still-processing retry without re-ingesting the track", async () => {
      // Durability: a prior upload committed the track but its enqueue failed —
      // the retry must recover it, not strand it in `processing` forever.
      mockRepo.createActivity.mockResolvedValue(activityRow());
      mockRepo.trackExists.mockResolvedValue(true);

      await service.create(user, uploadInput);

      expect(mockObjectStorage.put).not.toHaveBeenCalled();
      expect(mockRepo.ingestTrack).not.toHaveBeenCalled();
      expect(mockTrigger).toHaveBeenCalledWith("act-1");
    });

    it("rejects an upload whose uid belongs to another user", async () => {
      mockRepo.createActivity.mockResolvedValue(activityRow({ userId: 999 }));

      await expect(service.create(user, uploadInput)).rejects.toMatchObject({
        errorCode: "ALREADY_EXISTS",
        options: { reason: ActivityReason.ALREADY_EXISTS },
      });
      expect(mockRepo.trackExists).not.toHaveBeenCalled();
      expect(mockObjectStorage.put).not.toHaveBeenCalled();
      expect(mockRepo.ingestTrack).not.toHaveBeenCalled();
      expect(mockTrigger).not.toHaveBeenCalled();
    });
  });

  describe("detail", () => {
    it("throws NOT_FOUND when the activity isn't the user's", async () => {
      mockRepo.findByUidForUser.mockResolvedValue(undefined as never);
      await expect(service.detail(user, "nope")).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
        options: { reason: ActivityReason.NOT_FOUND },
      });
    });

    it("assembles summary + efforts + conditions", async () => {
      mockRepo.findByUidForUser.mockResolvedValue(
        activityRow({ markers: [12.5] }),
      );
      mockRepo.findSummaryByActivityId.mockResolvedValue(undefined as never);
      mockRepo.findRouteByActivityId.mockResolvedValue({
        polyline: "abc",
      } as never);
      mockRepo.findEffortsByActivityId.mockResolvedValue([
        { type: "time_10s", resultMs: 12, durationSec: 10, distanceM: null },
      ] as never);
      mockRepo.findConditionsByActivityId.mockResolvedValue([]);

      const result = await service.detail(user, "act-1");

      expect(result.polyline).toBe("abc");
      expect(result.markers).toEqual([12.5]);
      expect(result.efforts[0].type).toBe("time_10s");
      expect(result.summary).toBeNull();
    });

    it("defaults markers to [] when none were uploaded", async () => {
      mockRepo.findByUidForUser.mockResolvedValue(activityRow());
      mockRepo.findSummaryByActivityId.mockResolvedValue(undefined as never);
      mockRepo.findRouteByActivityId.mockResolvedValue(undefined as never);
      mockRepo.findEffortsByActivityId.mockResolvedValue([]);
      mockRepo.findConditionsByActivityId.mockResolvedValue([]);

      const result = await service.detail(user, "act-1");

      expect(result.markers).toEqual([]);
    });
  });

  describe("patchContext", () => {
    it("only sends provided fields and 404s when missing", async () => {
      mockRepo.updateContext.mockResolvedValue(activityRow());
      await service.patchContext(user, "act-1", {
        sport: "sailing",
        customName: null,
        notes: "great session",
      });
      expect(mockRepo.updateContext).toHaveBeenCalledWith("act-1", 1, {
        sport: "sailing",
        customName: null,
        notes: "great session",
      });

      mockRepo.updateContext.mockResolvedValue(undefined as never);
      await expect(
        service.patchContext(user, "nope", { notes: "x" }),
      ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
    });
  });

  describe("remove", () => {
    it("404s when nothing was deleted", async () => {
      mockRepo.deleteByUid.mockResolvedValue(false);
      await expect(service.remove(user, "nope")).rejects.toMatchObject({
        errorCode: "NOT_FOUND",
      });
    });
  });
});
