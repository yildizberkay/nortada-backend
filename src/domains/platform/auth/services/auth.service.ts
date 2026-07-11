import { decodeJwt, jwtVerify, SignJWT } from "jose";

import type { User } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import type { RequestUser } from "@/types";

import { AuthReason } from "../errors";
import type { UserRepository } from "../repositories/user.repository";
import type { ClerkService } from "./clerk.service";

// Anonymous tokens are long-lived — the app holds one in the Keychain for the
// device's whole anonymous lifetime. Low-privilege (own data only), so a long
// TTL is acceptable; rotation happens naturally on link/login.
const ANONYMOUS_TOKEN_TTL = "365d";
// Custom claim marking our own tokens so the middleware can tell them apart from
// Clerk tokens without a verify round-trip.
const ANONYMOUS_TOKEN_TYPE = "anonymous";
// Fixed issuer/audience — asserted on verify so `AUTH_ANONYMOUS_JWT_SECRET`
// can't be cross-purposed into a token another part of the system would accept.
const ANONYMOUS_TOKEN_ISSUER = "splash-anon";
const ANONYMOUS_TOKEN_AUDIENCE = "splash-api";

export interface AnonymousAuthResult {
  token: string;
  user: User;
}

export class AuthService extends BaseUseCase {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly clerkService: ClerkService,
  ) {
    super();
  }

  private get anonymousSecret(): Uint8Array {
    return new TextEncoder().encode(this.config.auth.anonymousJwtSecret);
  }

  private toRequestUser(user: User): RequestUser {
    return {
      id: user.id,
      uid: user.uid,
      isAnonymous: user.isAnonymous,
      clerkUserId: user.clerkUserId,
    };
  }

  /**
   * Bootstrap an anonymous identity for a device. Idempotent: the same
   * `deviceId` always resolves to the same user row, so a reinstall that keeps
   * the Keychain id keeps its history.
   */
  async issueAnonymous(deviceId: string): Promise<AnonymousAuthResult> {
    const existing =
      await this.userRepository.findByAnonymousDeviceId(deviceId);
    const user =
      existing ?? (await this.userRepository.createAnonymous(deviceId));

    const token = await new SignJWT({ tokenType: ANONYMOUS_TOKEN_TYPE })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.uid)
      .setIssuer(ANONYMOUS_TOKEN_ISSUER)
      .setAudience(ANONYMOUS_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(ANONYMOUS_TOKEN_TTL)
      .sign(this.anonymousSecret);

    return { token, user };
  }

  /**
   * Resolve a bearer token (anonymous OR Clerk) to the request principal. The
   * token type is peeked from the unverified claims, then verified by the right
   * path. Clerk users are provisioned on first sight.
   */
  async authenticateToken(token: string): Promise<RequestUser> {
    let claims: ReturnType<typeof decodeJwt>;
    try {
      claims = decodeJwt(token);
    } catch {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.INVALID_TOKEN,
        message: "Malformed authentication token",
      });
    }

    if (claims.tokenType === ANONYMOUS_TOKEN_TYPE) {
      return this.verifyAnonymous(token);
    }
    return this.verifyClerk(token);
  }

  private async verifyAnonymous(token: string): Promise<RequestUser> {
    let uid: string | undefined;
    try {
      const { payload } = await jwtVerify(token, this.anonymousSecret, {
        algorithms: ["HS256"],
        issuer: ANONYMOUS_TOKEN_ISSUER,
        audience: ANONYMOUS_TOKEN_AUDIENCE,
      });
      if (payload.tokenType !== ANONYMOUS_TOKEN_TYPE) {
        throw new Error("wrong token type");
      }
      uid = payload.sub;
    } catch {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.INVALID_TOKEN,
        message: "Invalid anonymous token",
      });
    }

    if (!uid) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.INVALID_TOKEN,
        message: "Anonymous token has no subject",
      });
    }

    const user = await this.userRepository.findByUid(uid);
    if (!user) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.USER_NOT_FOUND,
        message: "User not found",
      });
    }
    // A retired anonymous row (already merged into a Clerk account) must not
    // authenticate — the client should switch to its Clerk session.
    if (user.mergedIntoUserId !== null) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.ANONYMOUS_TOKEN_RETIRED,
        message: "This anonymous session has been linked to an account",
      });
    }

    return this.toRequestUser(user);
  }

  private async verifyClerk(token: string): Promise<RequestUser> {
    const identity = await this.clerkService.verifyToken(token);

    const existing = await this.userRepository.findByClerkUserId(
      identity.clerkUserId,
    );
    if (existing) {
      return this.toRequestUser(existing);
    }

    // First login on a fresh device that never went through /anonymous — mint
    // the Clerk-backed row now.
    const created = await this.userRepository.createClerkUser({
      clerkUserId: identity.clerkUserId,
      email: identity.email ?? null,
      displayName: null,
    });
    return this.toRequestUser(created);
  }

  /** Full user row for the current principal (GET /me). */
  async getCurrentUser(principal: RequestUser): Promise<User> {
    const user = await this.userRepository.findByUid(principal.uid);
    if (!user) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.USER_NOT_FOUND,
        message: "User not found",
      });
    }
    return user;
  }

  /**
   * Link an anonymous identity to a Clerk account (POST /link). Two branches:
   *  1. No Clerk row yet → upgrade the anonymous row in place (data stays put).
   *  2. Clerk row exists (user already signed in elsewhere) → reassign the
   *     anonymous row's owned records to it (future domains) and retire the
   *     anonymous row via `mergedIntoUserId`.
   * Idempotent: a re-link of an already-retired anonymous row is rejected.
   */
  async linkAnonymousToClerk(
    principal: RequestUser,
    clerkToken: string,
  ): Promise<User> {
    if (!principal.isAnonymous) {
      throw new GenericError("FORBIDDEN", {
        reason: AuthReason.NOT_ANONYMOUS,
        message: "Only an anonymous session can be linked",
      });
    }

    const anonUser = await this.userRepository.findByUid(principal.uid);
    if (!anonUser) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.USER_NOT_FOUND,
        message: "User not found",
      });
    }
    if (anonUser.mergedIntoUserId !== null) {
      throw new GenericError("ALREADY_EXISTS", {
        reason: AuthReason.ALREADY_LINKED,
        message: "This anonymous session is already linked",
      });
    }

    const identity = await this.clerkService.verifyToken(clerkToken);
    const existingClerkUser = await this.userRepository.findByClerkUserId(
      identity.clerkUserId,
    );

    // Branch 1 — no pre-existing Clerk row: upgrade in place. `tryUpgrade`
    // returns null if a concurrent /link just claimed this clerkUserId
    // (unique-index race), in which case we fall through to branch 2 instead
    // of 500ing.
    if (!existingClerkUser) {
      const upgraded = await this.userRepository.tryUpgradeAnonymousToClerk(
        anonUser.id,
        {
          clerkUserId: identity.clerkUserId,
          email: identity.email ?? null,
          displayName: null,
        },
      );
      if (upgraded) {
        return upgraded;
      }
    }

    // Branch 2 — Clerk row exists (or was just created by a racing request):
    // reassign this anonymous row's owned records to it (future domains) and
    // retire the anonymous row. Re-read to cover the race path.
    const target =
      existingClerkUser ??
      (await this.userRepository.findByClerkUserId(identity.clerkUserId));
    if (!target) {
      throw new GenericError("INTERNAL_ERROR", {
        message: "Link target user could not be resolved",
      });
    }
    await this.userRepository.markMergedInto(anonUser.id, target.id);
    return target;
  }
}
