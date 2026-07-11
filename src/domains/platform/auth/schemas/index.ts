import { z } from "zod";

// ── Requests ──────────────────────────────────────────────────────────────────

export const anonymousAuthSchema = z.object({
  // Stable device-scoped id the app persists in the Keychain. Same id → same
  // anonymous user (idempotent bootstrap).
  deviceId: z.string().min(8).max(256),
  // Optional App Attest / attestation blob (verified in a later phase — see
  // RFC-0002 §12). Accepted now so the client contract is stable.
  attestation: z.string().max(8192).optional(),
});
export type AnonymousAuthInput = z.infer<typeof anonymousAuthSchema>;

export const linkSchema = z.object({
  // A valid Clerk session token obtained by the client's Clerk SDK after Sign
  // in with Apple / email. The anonymous identity is taken from the request's
  // own bearer token (auth middleware).
  clerkToken: z.string().min(1),
});
export type LinkInput = z.infer<typeof linkSchema>;

export const refreshSchema = z.object({
  // The opaque refresh token issued by /anonymous (or a prior /refresh). It is
  // the credential here, so /refresh needs no bearer token.
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

// ── Responses ─────────────────────────────────────────────────────────────────

export const userResponseSchema = z
  .object({
    uid: z.string(),
    isAnonymous: z.boolean(),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
  })
  .describe("The authenticated user")
  .meta({ ref: "UserResponse" });

// `expiresIn` on the responses below = access-token lifetime (seconds) so the
// client knows when to call /refresh.
export const anonymousAuthResponseSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number(),
    user: userResponseSchema,
  })
  .describe("Anonymous access + refresh token pair + user")
  .meta({ ref: "AnonymousAuthResponse" });

export const refreshResponseSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number(),
  })
  .describe("A rotated access + refresh token pair")
  .meta({ ref: "RefreshResponse" });
