import { jwtVerify, SignJWT } from "jose";

import type { User } from "@/db";
import { GenericError } from "@/packages/error";

import { AuthReason } from "../errors";
import type { RefreshTokenRepository } from "../repositories/refresh-token.repository";
import type { UserRepository } from "../repositories/user.repository";
import { AuthService } from "./auth.service";
import type { ClerkService } from "./clerk.service";

const ANON_SECRET = new TextEncoder().encode(
  "test-anonymous-jwt-secret-32-chars-long!",
);

const makeAnonToken = (uid: string) =>
  new SignJWT({ tokenType: "anonymous" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(uid)
    .setIssuer("splash-anon")
    .setAudience("splash-api")
    .setIssuedAt()
    .sign(ANON_SECRET);

// A JWT that is NOT one of ours (no `tokenType`) — stands in for a Clerk token.
// decodeJwt only base64-decodes, so any signature works for the peek.
const makeClerkLikeToken = (sub: string) =>
  new SignJWT({ sub })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode("throwaway-clerk-signing-secret-value"));

const anonUser = (overrides: Partial<User> = {}): User =>
  ({
    id: 1,
    uid: "user-anon-uid",
    clerkUserId: null,
    isAnonymous: true,
    anonymousDeviceId: "device-123",
    email: null,
    displayName: null,
    isAdmin: false,
    mergedIntoUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as User;

const clerkUser = (overrides: Partial<User> = {}): User =>
  ({
    id: 2,
    uid: "user-clerk-uid",
    clerkUserId: "clerk_abc",
    isAnonymous: false,
    anonymousDeviceId: null,
    email: "a@b.com",
    displayName: "A B",
    isAdmin: false,
    mergedIntoUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as User;

const mockRepo = {
  findByUid: jest.fn(),
  findById: jest.fn(),
  findByClerkUserId: jest.fn(),
  findByAnonymousDeviceId: jest.fn(),
  createAnonymous: jest.fn(),
  createClerkUser: jest.fn(),
  tryUpgradeAnonymousToClerk: jest.fn(),
  markMergedInto: jest.fn(),
  transaction: jest.fn(),
} as unknown as jest.Mocked<UserRepository>;

const mockRefreshRepo = {
  create: jest.fn(),
  findByHash: jest.fn(),
  rotate: jest.fn(),
  revokeFamily: jest.fn(),
  revokeAllForUser: jest.fn(),
} as unknown as jest.Mocked<RefreshTokenRepository>;

const mockClerk = {
  verifyToken: jest.fn(),
} as unknown as jest.Mocked<ClerkService>;

const mockReassigner = jest.fn();

// A live refresh-token row (unexpired, unrevoked) unless overridden.
const refreshRecord = (overrides = {}) => ({
  id: 10,
  uid: "rt-uid",
  userId: 1,
  tokenHash: "stored-hash",
  familyId: "fam-1",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  revokedAt: null,
  replacedByHash: null,
  createdAt: new Date(),
  ...overrides,
});

describe("AuthService", () => {
  let service: AuthService;

  beforeEach(() => {
    service = new AuthService(mockRepo, mockRefreshRepo, mockClerk, [
      mockReassigner,
    ]);
    // Run the merge transaction callback immediately with a fake executor.
    mockRepo.transaction.mockImplementation(async (fn) => fn({} as never));
  });

  describe("issueAnonymous", () => {
    it("reuses the existing user for a known device (idempotent)", async () => {
      const user = anonUser();
      mockRepo.findByAnonymousDeviceId.mockResolvedValue(user);

      const result = await service.issueAnonymous("device-123");

      expect(mockRepo.createAnonymous).not.toHaveBeenCalled();
      expect(result.user).toBe(user);
      // A refresh token is persisted (hashed) and a raw one is returned.
      expect(mockRefreshRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id }),
      );
      expect(result.refreshToken).toEqual(expect.any(String));
      expect(result.expiresIn).toBe(15 * 60);
      const { payload } = await jwtVerify(result.accessToken, ANON_SECRET);
      expect(payload.sub).toBe(user.uid);
      expect(payload.tokenType).toBe("anonymous");
    });

    it("creates a new anonymous user for an unknown device", async () => {
      mockRepo.findByAnonymousDeviceId.mockResolvedValue(undefined as never);
      const created = anonUser({ uid: "fresh-uid" });
      mockRepo.createAnonymous.mockResolvedValue(created);

      const result = await service.issueAnonymous("new-device");

      expect(mockRepo.createAnonymous).toHaveBeenCalledWith("new-device");
      const { payload } = await jwtVerify(result.accessToken, ANON_SECRET);
      expect(payload.sub).toBe("fresh-uid");
    });
  });

  describe("refresh", () => {
    it("rotates a valid refresh token into a new access + refresh pair", async () => {
      mockRefreshRepo.findByHash.mockResolvedValue(refreshRecord() as never);
      mockRepo.findById.mockResolvedValue(anonUser());
      // A live row back from rotate = the atomic revoke matched (not a race).
      mockRefreshRepo.rotate.mockResolvedValue(refreshRecord() as never);

      const result = await service.refresh("raw-refresh-token");

      // Old token revoked + new one inserted (same family) atomically.
      expect(mockRefreshRepo.rotate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ userId: 1, familyId: "fam-1" }),
      );
      expect(result.refreshToken).toEqual(expect.any(String));
      expect(result.expiresIn).toBe(15 * 60);
      const { payload } = await jwtVerify(result.accessToken, ANON_SECRET);
      expect(payload.sub).toBe("user-anon-uid");
    });

    it("treats a lost rotation race (concurrent reuse) as theft and kills the family", async () => {
      mockRefreshRepo.findByHash.mockResolvedValue(refreshRecord() as never);
      mockRepo.findById.mockResolvedValue(anonUser());
      // Conditional revoke matched 0 rows → a concurrent /refresh already used it.
      mockRefreshRepo.rotate.mockResolvedValue(null as never);

      await expect(service.refresh("raced")).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.REFRESH_TOKEN_REUSED },
      });
      expect(mockRefreshRepo.revokeFamily).toHaveBeenCalledWith("fam-1");
    });

    it("rejects (and kills the family) when the owner was upgraded to a real account", async () => {
      // Branch-1 upgrade flips isAnonymous=false but leaves mergedIntoUserId null;
      // the !isAnonymous backstop must still sever the anonymous refresh path.
      mockRefreshRepo.findByHash.mockResolvedValue(refreshRecord() as never);
      mockRepo.findById.mockResolvedValue(anonUser({ isAnonymous: false }));

      await expect(service.refresh("post-upgrade")).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.REFRESH_TOKEN_INVALID },
      });
      expect(mockRefreshRepo.revokeFamily).toHaveBeenCalledWith("fam-1");
      expect(mockRefreshRepo.rotate).not.toHaveBeenCalled();
    });

    it("rejects an unknown refresh token", async () => {
      mockRefreshRepo.findByHash.mockResolvedValue(undefined as never);

      await expect(service.refresh("nope")).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.REFRESH_TOKEN_INVALID },
      });
      expect(mockRefreshRepo.rotate).not.toHaveBeenCalled();
    });

    it("detects reuse of a revoked token and revokes the whole family", async () => {
      mockRefreshRepo.findByHash.mockResolvedValue(
        refreshRecord({ revokedAt: new Date() }) as never,
      );

      await expect(service.refresh("replayed")).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.REFRESH_TOKEN_REUSED },
      });
      expect(mockRefreshRepo.revokeFamily).toHaveBeenCalledWith("fam-1");
      expect(mockRefreshRepo.rotate).not.toHaveBeenCalled();
    });

    it("rejects an expired refresh token", async () => {
      mockRefreshRepo.findByHash.mockResolvedValue(
        refreshRecord({ expiresAt: new Date(Date.now() - 1000) }) as never,
      );

      await expect(service.refresh("stale")).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.REFRESH_TOKEN_EXPIRED },
      });
    });

    it("revokes the family and rejects when the owning identity was retired", async () => {
      mockRefreshRepo.findByHash.mockResolvedValue(refreshRecord() as never);
      mockRepo.findById.mockResolvedValue(anonUser({ mergedIntoUserId: 2 }));

      await expect(service.refresh("orphaned")).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.REFRESH_TOKEN_INVALID },
      });
      expect(mockRefreshRepo.revokeFamily).toHaveBeenCalledWith("fam-1");
    });
  });

  describe("authenticateToken", () => {
    it("rejects a malformed token", async () => {
      await expect(
        service.authenticateToken("not-a-jwt"),
      ).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.INVALID_TOKEN },
      });
    });

    it("resolves a valid anonymous token to its user", async () => {
      const user = anonUser();
      mockRepo.findByUid.mockResolvedValue(user);
      const token = await makeAnonToken(user.uid);

      const principal = await service.authenticateToken(token);

      expect(principal).toEqual({
        id: 1,
        uid: "user-anon-uid",
        isAnonymous: true,
        clerkUserId: null,
        isAdmin: false,
      });
    });

    it("rejects an anonymous token whose row was merged/retired", async () => {
      const user = anonUser({ mergedIntoUserId: 2 });
      mockRepo.findByUid.mockResolvedValue(user);
      const token = await makeAnonToken(user.uid);

      await expect(service.authenticateToken(token)).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.ANONYMOUS_TOKEN_RETIRED },
      });
    });

    it("rejects an anonymous token signed with the wrong secret", async () => {
      const badToken = await new SignJWT({ tokenType: "anonymous" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("x")
        .sign(new TextEncoder().encode("some-other-secret-value-not-config!!"));

      await expect(service.authenticateToken(badToken)).rejects.toMatchObject({
        errorCode: "UNAUTHENTICATED",
        options: { reason: AuthReason.INVALID_TOKEN },
      });
    });

    it("resolves an existing Clerk user", async () => {
      mockClerk.verifyToken.mockResolvedValue({ clerkUserId: "clerk_abc" });
      mockRepo.findByClerkUserId.mockResolvedValue(clerkUser());
      const token = await makeClerkLikeToken("clerk_abc");

      const principal = await service.authenticateToken(token);

      expect(principal.clerkUserId).toBe("clerk_abc");
      expect(principal.isAnonymous).toBe(false);
      expect(mockRepo.createClerkUser).not.toHaveBeenCalled();
    });

    it("provisions a Clerk user on first sight", async () => {
      mockClerk.verifyToken.mockResolvedValue({
        clerkUserId: "clerk_new",
        email: "new@x.com",
      });
      mockRepo.findByClerkUserId.mockResolvedValue(undefined as never);
      mockRepo.createClerkUser.mockResolvedValue(
        clerkUser({ clerkUserId: "clerk_new", email: "new@x.com" }),
      );
      const token = await makeClerkLikeToken("clerk_new");

      await service.authenticateToken(token);

      expect(mockRepo.createClerkUser).toHaveBeenCalledWith({
        clerkUserId: "clerk_new",
        email: "new@x.com",
        displayName: null,
      });
    });
  });

  describe("linkAnonymousToClerk", () => {
    const principal = {
      id: 1,
      uid: "user-anon-uid",
      isAnonymous: true,
      clerkUserId: null,
      isAdmin: false,
    };

    it("rejects a non-anonymous principal", async () => {
      await expect(
        service.linkAnonymousToClerk(
          { ...principal, isAnonymous: false },
          "clerk-token",
        ),
      ).rejects.toMatchObject({
        errorCode: "FORBIDDEN",
        options: { reason: AuthReason.NOT_ANONYMOUS },
      });
    });

    it("rejects an already-linked anonymous row", async () => {
      mockRepo.findByUid.mockResolvedValue(anonUser({ mergedIntoUserId: 2 }));

      await expect(
        service.linkAnonymousToClerk(principal, "clerk-token"),
      ).rejects.toMatchObject({
        errorCode: "ALREADY_EXISTS",
        options: { reason: AuthReason.ALREADY_LINKED },
      });
    });

    it("branch 1: upgrades the anonymous row in place when no Clerk row exists", async () => {
      mockRepo.findByUid.mockResolvedValue(anonUser());
      mockClerk.verifyToken.mockResolvedValue({
        clerkUserId: "clerk_abc",
        email: "a@b.com",
      });
      mockRepo.findByClerkUserId.mockResolvedValue(undefined as never);
      const upgraded = clerkUser({ id: 1, uid: "user-anon-uid" });
      mockRepo.tryUpgradeAnonymousToClerk.mockResolvedValue(upgraded);

      const result = await service.linkAnonymousToClerk(
        principal,
        "clerk-token",
      );

      expect(mockRepo.tryUpgradeAnonymousToClerk).toHaveBeenCalledWith(1, {
        clerkUserId: "clerk_abc",
        email: "a@b.com",
        displayName: null,
      });
      expect(mockRepo.markMergedInto).not.toHaveBeenCalled();
      // The upgraded identity's anonymous refresh tokens are retired.
      expect(mockRefreshRepo.revokeAllForUser).toHaveBeenCalledWith(
        upgraded.id,
      );
      expect(result).toBe(upgraded);
    });

    it("branch 2: retires the anonymous row into the existing Clerk row", async () => {
      mockRepo.findByUid.mockResolvedValue(anonUser());
      mockClerk.verifyToken.mockResolvedValue({ clerkUserId: "clerk_abc" });
      const existing = clerkUser();
      mockRepo.findByClerkUserId.mockResolvedValue(existing);

      const result = await service.linkAnonymousToClerk(
        principal,
        "clerk-token",
      );

      // Reassign runs before the anon row is retired, inside the transaction.
      expect(mockReassigner).toHaveBeenCalledWith(1, existing.id, {});
      // Refresh tokens are revoked inside the same merge transaction.
      expect(mockRefreshRepo.revokeAllForUser).toHaveBeenCalledWith(1, {});
      expect(mockRepo.markMergedInto).toHaveBeenCalledWith(1, existing.id, {});
      expect(mockRepo.tryUpgradeAnonymousToClerk).not.toHaveBeenCalled();
      expect(result).toBe(existing);
    });

    it("falls through to branch 2 when a concurrent /link wins the upgrade race", async () => {
      mockRepo.findByUid.mockResolvedValue(anonUser());
      mockClerk.verifyToken.mockResolvedValue({ clerkUserId: "clerk_abc" });
      // No Clerk row on first read → branch 1 attempted, but the upgrade loses
      // the unique-index race (null), then the re-read finds the winner.
      const winner = clerkUser();
      mockRepo.findByClerkUserId
        .mockResolvedValueOnce(undefined as never)
        .mockResolvedValueOnce(winner);
      mockRepo.tryUpgradeAnonymousToClerk.mockResolvedValue(null);

      const result = await service.linkAnonymousToClerk(
        principal,
        "clerk-token",
      );

      expect(mockRepo.tryUpgradeAnonymousToClerk).toHaveBeenCalled();
      expect(mockRepo.markMergedInto).toHaveBeenCalledWith(1, winner.id, {});
      expect(result).toBe(winner);
    });
  });

  describe("getCurrentUser", () => {
    it("returns the full user row", async () => {
      const user = clerkUser();
      mockRepo.findByUid.mockResolvedValue(user);

      const result = await service.getCurrentUser({
        id: 2,
        uid: "user-clerk-uid",
        isAnonymous: false,
        clerkUserId: "clerk_abc",
        isAdmin: false,
      });

      expect(result).toBe(user);
    });

    it("throws when the user is gone", async () => {
      mockRepo.findByUid.mockResolvedValue(undefined as never);

      await expect(
        service.getCurrentUser({
          id: 9,
          uid: "ghost",
          isAnonymous: true,
          clerkUserId: null,
          isAdmin: false,
        }),
      ).rejects.toThrow(GenericError);
    });
  });
});
