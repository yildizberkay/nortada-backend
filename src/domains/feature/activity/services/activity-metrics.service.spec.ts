import { gzipSync } from "node:zlib";

import type { Activity } from "@/db";

import type { ActivityRepository } from "../repositories/activity.repository";
import { ActivityMetricsService } from "./activity-metrics.service";

const activity = { id: 10, uid: "act-1", dataVersion: 1 } as Activity;

// A ~2-minute straight track so efforts are produced.
const samples = Array.from({ length: 120 }, (_, i) => ({
  t: i,
  lat: 38 + (i * 10) / 111_320,
  lon: 26,
  speed: 10,
  hAccuracy: 5,
}));

// The stored object: gzipped JSON, exactly as ActivityService writes it.
const gzippedTrack = gzipSync(Buffer.from(JSON.stringify(samples)));

const mockRepo = {
  findByUid: jest.fn(),
  findTrackByActivityId: jest.fn(),
  upsertSummary: jest.fn(),
  upsertRoute: jest.fn(),
  replaceEfforts: jest.fn(),
  setStatus: jest.fn(),
} as unknown as jest.Mocked<ActivityRepository>;

const mockObjectStorage = {
  put: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
};

describe("ActivityMetricsService", () => {
  let service: ActivityMetricsService;

  beforeEach(() => {
    service = new ActivityMetricsService(mockRepo, mockObjectStorage);
  });

  it("computes + stores summary/route/efforts and marks ready", async () => {
    mockRepo.findByUid.mockResolvedValue(activity);
    mockRepo.findTrackByActivityId.mockResolvedValue({
      storageKey: "activities/act-1/track.json.gz",
    } as never);
    mockObjectStorage.get.mockResolvedValue(gzippedTrack);

    await service.computeAndStore("act-1");

    expect(mockRepo.upsertSummary).toHaveBeenCalledWith(
      expect.objectContaining({ activityId: 10, algorithmVersion: 1 }),
    );
    expect(mockRepo.upsertRoute).toHaveBeenCalled();
    expect(mockRepo.replaceEfforts).toHaveBeenCalledWith(
      10,
      expect.arrayContaining([expect.objectContaining({ type: "time_10s" })]),
    );
    expect(mockRepo.setStatus).toHaveBeenCalledWith(10, "ready");
  });

  it("throws NOT_FOUND for a missing activity", async () => {
    mockRepo.findByUid.mockResolvedValue(undefined as never);
    await expect(service.computeAndStore("nope")).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
    });
  });

  it("marks the activity failed and rethrows on error", async () => {
    mockRepo.findByUid.mockResolvedValue(activity);
    mockRepo.findTrackByActivityId.mockResolvedValue({
      storageKey: "activities/act-1/track.json.gz",
    } as never);
    mockObjectStorage.get.mockResolvedValue(gzippedTrack);
    mockRepo.upsertSummary.mockRejectedValue(new Error("db down"));

    await expect(service.computeAndStore("act-1")).rejects.toThrow("db down");
    expect(mockRepo.setStatus).toHaveBeenCalledWith(10, "failed");
  });
});
