import { verifyToken } from "@clerk/backend";
import {
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";

import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";

import { AuthReason } from "../errors";

export interface ClerkIdentity {
  clerkUserId: string;
  email?: string;
}

// Clerk verification failures that are OUR/Clerk's infrastructure, not a bad
// client token — these must surface as reportable 5xx (so an outage is visible
// on dashboards), never as a 401 that traps the user in a re-login loop.
const INFRA_FAILURE_REASONS = new Set<string>([
  TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  TokenVerificationErrorReason.RemoteJWKInvalid,
  TokenVerificationErrorReason.RemoteJWKMissing,
  TokenVerificationErrorReason.JWKFailedToResolve,
  TokenVerificationErrorReason.JWKKidMismatch,
  TokenVerificationErrorReason.LocalJWKMissing,
  TokenVerificationErrorReason.TokenVerificationFailed,
  TokenVerificationErrorReason.InvalidSecretKey,
]);

/**
 * Thin wrapper around Clerk's token verification. Kept separate from
 * `AuthService` so the Clerk boundary is mockable in unit tests. Reads secrets
 * at call time (not in the constructor) to keep construction cheap.
 *
 * Prefers networkless verification (`jwtKey`) and passes `authorizedParties`
 * (azp) when configured, per Clerk's hardening guidance.
 */
export class ClerkService extends BaseUseCase {
  async verifyToken(token: string): Promise<ClerkIdentity> {
    const { secretKey, jwtKey, authorizedParties } = this.config.clerk;
    // Either a networkless public key OR a secret key must be present.
    if (!jwtKey && !secretKey) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.CLERK_NOT_CONFIGURED,
        message: "Clerk authentication is not configured",
      });
    }

    try {
      const payload = await verifyToken(token, {
        ...(jwtKey ? { jwtKey } : { secretKey }),
        ...(authorizedParties?.length ? { authorizedParties } : {}),
      });
      const email = (payload as { email?: unknown }).email;
      return {
        clerkUserId: payload.sub,
        email: typeof email === "string" ? email : undefined,
      };
    } catch (error) {
      // Distinguish an infra outage (report + 5xx) from a genuinely bad token
      // (silent 401). Collapsing both to 401 blinds ops during an outage.
      if (
        error instanceof TokenVerificationError &&
        INFRA_FAILURE_REASONS.has(error.reason)
      ) {
        throw new GenericError("EXTERNAL_SERVICE_ERROR", {
          reason: AuthReason.CLERK_UNAVAILABLE,
          message: "Clerk verification is temporarily unavailable",
        });
      }
      if (error instanceof TokenVerificationError) {
        throw new GenericError("UNAUTHENTICATED", {
          reason: AuthReason.INVALID_TOKEN,
          message: "Invalid Clerk session token",
        });
      }
      // Non-Clerk error (e.g. a raw network failure) — treat as infra.
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        reason: AuthReason.CLERK_UNAVAILABLE,
        message: "Clerk verification failed",
      });
    }
  }
}
