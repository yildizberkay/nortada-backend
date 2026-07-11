import { createLogger } from "@/packages/logger";

/**
 * App-wide tracking primitive. Foundation ships a logging-only implementation
 * (no PostHog/Sentry yet — see docs/otonom-kararlar.md §3). The interface
 * matches what a real analytics domain would expose, so call sites
 * (error-handler middleware) never change when a real client is wired in.
 */
export interface TrackingActor {
  userUid?: string;
}

export interface TrackingExtra {
  path?: string;
  [key: string]: unknown;
}

class LoggingTracking {
  private readonly logger = createLogger("Tracking");

  captureException(
    error: unknown,
    actor?: TrackingActor,
    extra?: TrackingExtra,
  ): void {
    this.logger.error("captureException", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      actor,
      extra,
    });
  }

  trackErrorEvent(
    error: unknown,
    actor?: TrackingActor,
    extra?: TrackingExtra,
  ): void {
    this.logger.warn("trackErrorEvent", {
      error: error instanceof Error ? error.message : String(error),
      actor,
      extra,
    });
  }
}

export const Tracking = new LoggingTracking();
