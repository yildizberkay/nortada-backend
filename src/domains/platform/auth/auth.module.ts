import type { ModuleDeps } from "@/container";
import type { MergeReassigner } from "@/types";

import { UserRepository } from "./repositories/user.repository";
import { AuthService } from "./services/auth.service";
import { ClerkService } from "./services/clerk.service";

export interface AuthModuleDeps extends ModuleDeps {
  // Merge hooks from data-owning domains (D-008) — passed explicitly at the
  // composition root so auth never imports feature domains.
  mergeReassigners: MergeReassigner[];
}

export function createAuthModule({ db, mergeReassigners }: AuthModuleDeps) {
  const userRepository = new UserRepository(db);
  const clerkService = new ClerkService();
  const authService = new AuthService(
    userRepository,
    clerkService,
    mergeReassigners,
  );
  return { authService };
}
