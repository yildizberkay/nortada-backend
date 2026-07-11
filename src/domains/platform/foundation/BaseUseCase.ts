import { globalConfig } from "@/app/global-config";

/**
 * Base class for services (use cases). Services orchestrate business logic and
 * MUST NOT touch the database — they get no `dbClient`, only `this.config`.
 */
export class BaseUseCase {
  get config() {
    return globalConfig.config;
  }

  get isDev(): boolean {
    return globalConfig.isDev;
  }
}
