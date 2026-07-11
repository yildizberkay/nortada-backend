import { jwtVerify, SignJWT } from "jose";

import type { User } from "@/db";
import { GenericError } from "@/packages/error";

import { AuthReason } from "../errors";
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
    mergedIntoUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as User;

const mockRepo = {
  findByUid: jest.fn(),
  findByClerkUserId: jest.fn(),
  findByAnonymousDeviceId: jest.fn(),
  createAnonymous: jest.fn(),
  createClerkUser: jest.fn(),
  tryUpgradeAnonymousToClerk: jest.fn(),
  markMergedInto: jest.fn(),
} as unknown as jest.Mocked<UserRepository>;

const mockClerk = {
  verifyToken: jest.fn(),
} as unknown as jest.Mocked<ClerkService>;

describe("AuthService", () => {
  let service: AuthService;

  beforeEach(() => {
    service = new AuthService(mockRepo, mockClerk);
  });

  describe("issueAnonymous", () => {
    it("reuses the existing user for a known device (idempotent)", async () => {
      const user = anonUser();
      mockRepo.findByAnonymousDeviceId.mockResolvedValue(user);

      const result = await service.issueAnonymous("device-123");

      expect(mockRepo.createAnonymous).not.toHaveBeenCalled();
      expect(result.user).toBe(user);
      const { payload } = await jwtVerify(result.token, ANON_SECRET);
      expect(payload.sub).toBe(user.uid);
      expect(payload.tokenType).toBe("anonymous");
    });

    it("creates a new anonymous user for an unknown device", async () => {
      mockRepo.findByAnonymousDeviceId.mockResolvedValue(undefined as never);
      const created = anonUser({ uid: "fresh-uid" });
      mockRepo.createAnonymous.mockResolvedValue(created);

      const result = await service.issueAnonymous("new-device");

      expect(mockRepo.createAnonymous).toHaveBeenCalledWith("new-device");
      const { payload } = await jwtVerify(result.token, ANON_SECRET);
      expect(payload.sub).toBe("fresh-uid");
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

      expect(mockRepo.markMergedInto).toHaveBeenCalledWith(1, existing.id);
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
      expect(mockRepo.markMergedInto).toHaveBeenCalledWith(1, winner.id);
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
        }),
      ).rejects.toThrow(GenericError);
    });
  });
});
