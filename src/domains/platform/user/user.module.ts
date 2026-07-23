import type { ModuleDeps } from "@/container";
import type { MergeReassigner } from "@/types";

import { UserProfileRepository } from "./repositories/user-profile.repository";
import { UserProfileService } from "./services/user-profile.service";

export function createUserModule({ db }: ModuleDeps) {
  const userProfileRepository = new UserProfileRepository(db);
  const userProfileService = new UserProfileService(userProfileRepository);
  const userProfileReassigner: MergeReassigner = async (from, to, tx) => {
    await userProfileRepository.mergeIntoExistingAccount(from, to, tx);
  };
  return { userProfileService, userProfileReassigner };
}
