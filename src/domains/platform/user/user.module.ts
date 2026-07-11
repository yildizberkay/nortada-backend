import type { ModuleDeps } from "@/container";

import { UserProfileRepository } from "./repositories/user-profile.repository";
import { UserProfileService } from "./services/user-profile.service";

export function createUserModule({ db }: ModuleDeps) {
  const userProfileRepository = new UserProfileRepository(db);
  const userProfileService = new UserProfileService(userProfileRepository);
  return { userProfileService };
}
