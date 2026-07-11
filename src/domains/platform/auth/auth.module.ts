import type { ModuleDeps } from "@/container";

import { UserRepository } from "./repositories/user.repository";
import { AuthService } from "./services/auth.service";
import { ClerkService } from "./services/clerk.service";

export function createAuthModule({ db }: ModuleDeps) {
  const userRepository = new UserRepository(db);
  const clerkService = new ClerkService();
  const authService = new AuthService(userRepository, clerkService);
  return { authService };
}
