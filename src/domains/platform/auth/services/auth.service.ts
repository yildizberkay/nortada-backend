import { createHash, randomBytes, randomUUID } from "node:crypto";

import { decodeJwt, jwtVerify, SignJWT } from "jose";

import type { NewRefreshToken, User } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import type { MergeReassigner, RequestUser } from "@/types";

import { AuthReason } from "../errors";
import type { RefreshTokenRepository } from "../repositories/refresh-token.repository";
import type { UserRepository } from "../repositories/user.repository";
import type { ClerkService } from "./clerk.service";

// Access tokens are SHORT-LIVED (RFC-0002, Berkay 2026-07-11): a stolen token is
// useful for minutes, not a year. The client refreshes silently via the refresh
// token before expiry. 15 min balances churn vs. exposure.
const ACCESS_TOKEN_TTL_SEC = 15 * 60;
// Refresh tokens are long-lived and rotated on every use; the app keeps the
// current one in the Keychain. 60 days ≈ how long a device can be offline and
// still refresh without a full re-bootstrap.
const REFRESH_TOKEN_TTL_SEC = 60 * 24 * 60 * 60;
// Custom claim marking our own tokens so the middleware can tell them apart from
// Clerk tokens without a verify round-trip.
const ANONYMOUS_TOKEN_TYPE = "anonymous";
// Fixed issuer/audience — asserted on verify so `AUTH_ANONYMOUS_JWT_SECRET`
// can't be cross-purposed into a token another part of the system would accept.
const ANONYMOUS_TOKEN_ISSUER = "nortada-anon";
const ANONYMOUS_TOKEN_AUDIENCE = "nortada-api";

// Refresh tokens are opaque high-entropy strings stored HASHED — the raw value
// exists only in transit and in the client Keychain.
const hashToken = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");
const generateRefreshTokenRaw = (): string =>
  randomBytes(32).toString("base64url");

/** A freshly-minted access + refresh pair. `expiresIn` is the access-token
 * lifetime in seconds so the client knows when to refresh. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AnonymousAuthResult extends TokenPair {
  user: User;
}

export class AuthService extends BaseUseCase {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly refreshTokenRepository: RefreshTokenRepository,
    private readonly clerkService: ClerkService,
    // One per data-owning domain (spot/favorites, later activity). Run inside
    // the merge transaction so an account-link never half-moves owned data.
    private readonly mergeReassigners: MergeReassigner[] = [],
  ) {
    super();
  }

  private get anonymousSecret(): Uint8Array {
    return new TextEncoder().encode(this.config.auth.anonymousJwtSecret);
  }

  /** Mint a short-lived access token (our HS256 anonymous JWT). */
  private mintAccessToken(user: User): Promise<string> {
    return new SignJWT({ tokenType: ANONYMOUS_TOKEN_TYPE })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.uid)
      .setIssuer(ANONYMOUS_TOKEN_ISSUER)
      .setAudience(ANONYMOUS_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
      .sign(this.anonymousSecret);
  }

  /** Build a persistable refresh-token row (hashed) + return the raw value to
   * hand to the client once. */
  private buildRefreshToken(
    userId: number,
    familyId: string,
  ): { raw: string; row: NewRefreshToken } {
    const raw = generateRefreshTokenRaw();
    return {
      raw,
      row: {
        userId,
        tokenHash: hashToken(raw),
        familyId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
      },
    };
  }

  private toRequestUser(user: User): RequestUser {
    return {
      id: user.id,
      uid: user.uid,
      isAnonymous: user.isAnonymous,
      clerkUserId: user.clerkUserId,
      isAdmin: user.isAdmin,
    };
  }

  /**
   * Bootstrap an anonymous identity for a device and issue the first token pair.
   * Idempotent on `deviceId`: the same device always resolves to the same user
   * row (a reinstall that keeps the Keychain id keeps its history), but each
   * bootstrap starts a fresh refresh-token family.
   */
  async issueAnonymous(deviceId: string): Promise<AnonymousAuthResult> {
    const existing =
      await this.userRepository.findByAnonymousDeviceId(deviceId);
    const user =
      existing ?? (await this.userRepository.createAnonymous(deviceId));

    const accessToken = await this.mintAccessToken(user);
    const { raw, row } = this.buildRefreshToken(user.id, randomUUID());
    await this.refreshTokenRepository.create(row);

    return {
      accessToken,
      refreshToken: raw,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      user,
    };
  }

  /**
   * Exchange a refresh token for a new access + refresh pair (rotation). The old
   * refresh token is revoked; the new one stays in the same family. Replaying an
   * already-rotated token is treated as theft — the whole family is revoked.
   */
  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    const presentedHash = hashToken(rawRefreshToken);
    const record = await this.refreshTokenRepository.findByHash(presentedHash);

    if (!record) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.REFRESH_TOKEN_INVALID,
        message: "Invalid refresh token",
      });
    }
    // Reuse detection: a revoked token was replayed → assume the family is
    // compromised and revoke every token descended from that login.
    if (record.revokedAt !== null) {
      await this.refreshTokenRepository.revokeFamily(record.familyId);
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.REFRESH_TOKEN_REUSED,
        message: "Refresh token has already been used",
      });
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.REFRESH_TOKEN_EXPIRED,
        message: "Refresh token has expired",
      });
    }

    const user = await this.userRepository.findById(record.userId);
    // Refresh tokens only ever belong to a LIVE anonymous device. If the owner is
    // gone, retired by a link (`mergedIntoUserId`), or upgraded in place to a
    // real account (`!isAnonymous`), the token can never be valid again — this is
    // the durable backstop that severs the anonymous refresh path on link even if
    // an explicit revoke was missed. Revoke the family and reject.
    if (!user || user.mergedIntoUserId !== null || !user.isAnonymous) {
      await this.refreshTokenRepository.revokeFamily(record.familyId);
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.REFRESH_TOKEN_INVALID,
        message: "Refresh token is no longer valid",
      });
    }

    // Rotate atomically. A null result means a concurrent /refresh already
    // consumed this token → treat the loser as reuse (revoke the whole family).
    const { raw, row } = this.buildRefreshToken(user.id, record.familyId);
    const rotated = await this.refreshTokenRepository.rotate(
      presentedHash,
      row,
    );
    if (!rotated) {
      await this.refreshTokenRepository.revokeFamily(record.familyId);
      throw new GenericError("UNAUTHENTICATED", {
        reason: AuthReason.REFRESH_TOKEN_REUSED,
        message: "Refresh token has already been used",
      });
    }

    const accessToken = await this.mintAccessToken(user);
    return { accessToken, refreshToken: raw, expiresIn: ACCESS_TOKEN_TTL_SEC };
  }

  /** Maintenance: delete expired refresh tokens (invoked by the cleanup cron).
   * Revoked-but-unexpired reuse tripwires are preserved (see the repository). */
  async cleanupExpiredRefreshTokens(): Promise<number> {
    return this.refreshTokenRepository.deleteExpired();
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
        // Small tolerance for NTP skew across instances — access tokens are now
        // short-lived (15 min), so there's less margin than the old 365d token.
        clockTolerance: 10,
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
        // The anonymous session is now a real account — retire its refresh
        // tokens so the old anonymous refresh flow can't mint access tokens for
        // the upgraded identity. The client uses its Clerk session from here.
        await this.refreshTokenRepository.revokeAllForUser(upgraded.id);
        return upgraded;
      }
    }

    // Branch 2 — Clerk row exists (or was just created by a racing request):
    // atomically reassign this anonymous row's owned data (favorites, later
    // activities) to the target, then retire the anonymous row (D-008). One
    // transaction so a partial failure never orphans or half-moves data.
    const target =
      existingClerkUser ??
      (await this.userRepository.findByClerkUserId(identity.clerkUserId));
    if (!target) {
      throw new GenericError("INTERNAL_ERROR", {
        message: "Link target user could not be resolved",
      });
    }
    await this.userRepository.transaction(async (tx) => {
      for (const reassign of this.mergeReassigners) {
        await reassign(anonUser.id, target.id, tx);
      }
      // Retire the anonymous session's refresh tokens inside the same merge
      // transaction — a retired identity must not be refreshable.
      await this.refreshTokenRepository.revokeAllForUser(anonUser.id, tx);
      await this.userRepository.markMergedInto(anonUser.id, target.id, tx);
    });
    return target;
  }
}
