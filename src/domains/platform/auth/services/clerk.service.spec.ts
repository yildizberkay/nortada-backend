import { verifyToken } from "@clerk/backend";
import {
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";

import { globalConfig } from "@/app/global-config";
import { AuthReason } from "../errors";
import { ClerkService } from "./clerk.service";

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(),
}));

const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;

// Access the injected mock config to toggle the Clerk secret per test.
const config = (
  globalConfig as unknown as { _config: { clerk: { secretKey?: string } } }
)._config;

describe("ClerkService", () => {
  let service: ClerkService;
  let originalSecret: string | undefined;

  beforeEach(() => {
    service = new ClerkService();
    originalSecret = config.clerk.secretKey;
  });

  afterEach(() => {
    config.clerk.secretKey = originalSecret;
  });

  it("returns the clerk identity from a verified token", async () => {
    mockVerifyToken.mockResolvedValue({
      sub: "clerk_123",
      email: "user@example.com",
    } as never);

    const identity = await service.verifyToken("good-token");

    expect(identity).toEqual({
      clerkUserId: "clerk_123",
      email: "user@example.com",
    });
    expect(mockVerifyToken).toHaveBeenCalledWith("good-token", {
      secretKey: "test-clerk-secret",
    });
  });

  it("omits email when the token has no email claim", async () => {
    mockVerifyToken.mockResolvedValue({ sub: "clerk_123" } as never);

    const identity = await service.verifyToken("good-token");

    expect(identity).toEqual({ clerkUserId: "clerk_123", email: undefined });
  });

  it("throws CLERK_NOT_CONFIGURED when no secret key is set", async () => {
    config.clerk.secretKey = undefined;

    await expect(service.verifyToken("any")).rejects.toMatchObject({
      errorCode: "UNAUTHENTICATED",
      options: { reason: AuthReason.CLERK_NOT_CONFIGURED },
    });
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it("throws INVALID_TOKEN on a token-verification error (bad/expired token)", async () => {
    mockVerifyToken.mockRejectedValue(
      new TokenVerificationError({
        reason: TokenVerificationErrorReason.TokenExpired,
        message: "expired",
      }),
    );

    await expect(service.verifyToken("bad-token")).rejects.toMatchObject({
      errorCode: "UNAUTHENTICATED",
      options: { reason: AuthReason.INVALID_TOKEN },
    });
  });

  it("throws EXTERNAL_SERVICE_ERROR on a JWKS/infra failure", async () => {
    mockVerifyToken.mockRejectedValue(
      new TokenVerificationError({
        reason: TokenVerificationErrorReason.RemoteJWKFailedToLoad,
        message: "jwks unreachable",
      }),
    );

    await expect(service.verifyToken("any")).rejects.toMatchObject({
      errorCode: "EXTERNAL_SERVICE_ERROR",
      options: { reason: AuthReason.CLERK_UNAVAILABLE },
    });
  });

  it("throws EXTERNAL_SERVICE_ERROR on a non-Clerk (network) error", async () => {
    mockVerifyToken.mockRejectedValue(new Error("socket hang up"));

    await expect(service.verifyToken("any")).rejects.toMatchObject({
      errorCode: "EXTERNAL_SERVICE_ERROR",
      options: { reason: AuthReason.CLERK_UNAVAILABLE },
    });
  });
});
