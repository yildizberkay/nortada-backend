import { logger, schedules } from "@trigger.dev/sdk/v3";

import {
  finalizeTrigger,
  initializeForTrigger,
} from "@/app/initialize-services";
import { Tracking } from "@/app/tracking";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

/**
 * Garbage-collect EXPIRED refresh tokens so the `refresh_token` table (and its
 * hot `token_hash` lookup index) don't grow without bound as devices rotate
 * every 15 min. Revoked-but-unexpired reuse tripwires are deliberately kept (see
 * `RefreshTokenRepository.deleteExpired`). A daily cron `schedules.task`.
 */
export const refreshTokenCleanupTask = schedules.task({
  id: "refresh-token-cleanup",
  // Daily at 03:00 UTC — off-peak; the sweep is not time-sensitive.
  cron: "0 3 * * *",
  maxDuration: 300,
  retry: { maxAttempts: 3 },
  queue: { concurrencyLimit: 1 },
  run: async () => {
    initializeForTrigger();
    const dbManager = await createDBManagerForTrigger();
    try {
      const services = buildContainer(dbManager);
      const deleted = await services.authService.cleanupExpiredRefreshTokens();
      logger.info("Expired refresh tokens cleaned up", { deleted });
      return { deleted };
    } catch (error) {
      Tracking.captureException(error, undefined, {
        taskId: "refresh-token-cleanup",
      });
      throw error;
    } finally {
      await finalizeTrigger(dbManager);
    }
  },
});
