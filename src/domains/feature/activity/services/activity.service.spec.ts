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
  insertTrack: jest.fn(),
  findTrackByActivityId: jest.fn(),
  insertConditions: jest.fn(),
  insertEquipmentLink: jest.fn(),
  findSummaryByActivityId: jest.fn(),
  findRouteByActivityId: jest.fn(),
  findEffortsByActivityId: jest.fn(),
  findConditionsByActivityId: jest.fn(),
} as unknown as jest.Mocked<ActivityRepository>;

const mockEquipmentRepo = {
  findByUidForUser: jest.fn(),
} as unknown as jest.Mocked<EquipmentRepository>;

describe("ActivityService", () => {
  let service: ActivityService;

  beforeEach(() => {
    service = new ActivityService(mockRepo, mockEquipmentRepo);
  });

  describe("create", () => {
    it("ingests a fresh upload and enqueues metric computation", async () => {
      mockRepo.createActivity.mockResolvedValue(activityRow());
      mockRepo.findTrackByActivityId.mockResolvedValue(undefined as never);

      const result = await service.create(user, uploadInput);

      expect(mockRepo.insertTrack).toHaveBeenCalledWith(
        expect.objectContaining({ activityId: 10, sampleCount: 2 }),
      );
      expect(mockTrigger).toHaveBeenCalledWith("act-1");
      expect(result).toEqual({ uid: "act-1", status: "processing" });
    });

    it("is idempotent — a retried upload does not re-ingest or re-enqueue", async () => {
      mockRepo.createActivity.mockResolvedValue(activityRow());
      mockRepo.findTrackByActivityId.mockResolvedValue({ id: 1 } as never);

      await service.create(user, uploadInput);

      expect(mockRepo.insertTrack).not.toHaveBeenCalled();
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
      mockRepo.findByUidForUser.mockResolvedValue(activityRow());
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
      expect(result.efforts[0].type).toBe("time_10s");
      expect(result.summary).toBeNull();
    });
  });

  describe("patchContext", () => {
    it("only sends provided fields and 404s when missing", async () => {
      mockRepo.updateContext.mockResolvedValue(activityRow());
      await service.patchContext(user, "act-1", { notes: "great session" });
      expect(mockRepo.updateContext).toHaveBeenCalledWith("act-1", 1, {
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
