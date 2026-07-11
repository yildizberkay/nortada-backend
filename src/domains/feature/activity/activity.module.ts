import type { ModuleDeps } from "@/container";
import { S3ObjectStorage } from "@/packages/object-storage";
import type { MergeReassigner } from "@/types";

import { ActivityRepository } from "./repositories/activity.repository";
import { EquipmentRepository } from "./repositories/equipment.repository";
import { ActivityService } from "./services/activity.service";
import { ActivityMetricsService } from "./services/activity-metrics.service";
import { EquipmentService } from "./services/equipment.service";

export function createActivityModule({ db }: ModuleDeps) {
  const activityRepository = new ActivityRepository(db);
  const equipmentRepository = new EquipmentRepository(db);
  // Raw-track blob store (S3). Config-free construction; the client is built
  // lazily on first use (import-safe, like OpenMeteoClient).
  const objectStorage = new S3ObjectStorage();

  const activityService = new ActivityService(
    activityRepository,
    equipmentRepository,
    objectStorage,
  );
  const activityMetricsService = new ActivityMetricsService(
    activityRepository,
    objectStorage,
  );
  const equipmentService = new EquipmentService(equipmentRepository);

  // Merge hook (D-008): a user's activities + equipment move to the target
  // account on link, in the merge transaction.
  const activityReassigner: MergeReassigner = async (from, to, tx) => {
    await activityRepository.reassignOwner(from, to, tx);
    await equipmentRepository.reassignOwner(from, to, tx);
  };

  return {
    activityService,
    activityMetricsService,
    equipmentService,
    activityReassigner,
  };
}
