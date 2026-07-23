import { verifyToken } from "@clerk/backend";
import {
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";
import { decodeJwt } from "jose";

import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";

import { AuthReason } from "../errors";

const logger = createLogger("clerk");

const tokenAuthorizedParty = (token: string): string | undefined => {
  try {
    const azp = (decodeJwt(token) as { azp?: unknown }).azp;
    return typeof azp === "string" ? azp : undefined;
  } catch {
    return undefined;
  }
};

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
 * Verifies via `secretKey` (Clerk's client fetches and caches JWKS) and passes
 * `authorizedParties` (azp) when configured, per Clerk's hardening guidance.
 */
export class ClerkService extends BaseUseCase {
  async verifyToken(token: string): Promise<ClerkIdentity> {
    const { secretKey, authorizedParties } = this.config.clerk;
    if (!secretKey) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.CLERK_NOT_CONFIGURED,
        message: "Clerk authentication is not configured",
      });
    }

    try {
      // `authorizedParties` validates the web Origin carried in `azp`; it is
      // not a native bundle-ID check. Clerk's native iOS session tokens do not
      // carry `azp`, and Clerk's verification guide explicitly says to skip
      // this check when the claim is absent. Signature, issuer, and time claims
      // are still verified by `verifyToken` in both cases.
      const hasAuthorizedParty = tokenAuthorizedParty(token) !== undefined;
      const payload = await verifyToken(token, {
        secretKey,
        ...(authorizedParties?.length && hasAuthorizedParty
          ? { authorizedParties }
          : {}),
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
        let tokenMetadata: Record<string, unknown> = { readable: false };
        try {
          const payload = decodeJwt(token);
          tokenMetadata = {
            readable: true,
            issuer: payload.iss,
            audience: payload.aud,
            authorizedParty: (payload as { azp?: unknown }).azp,
            issuedAt: payload.iat,
            expiresAt: payload.exp,
          };
        } catch {
          // Verification already failed; diagnostic decoding must never mask it.
        }
        logger.debug("Clerk session token rejected", {
          reason: error.reason,
          configuredAuthorizedParties: authorizedParties,
          token: tokenMetadata,
        });
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
