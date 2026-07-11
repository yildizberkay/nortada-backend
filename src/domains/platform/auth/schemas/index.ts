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

export const anonymousAuthResponseSchema = z
  .object({
    token: z.string(),
    user: userResponseSchema,
  })
  .describe("Anonymous auth token + user")
  .meta({ ref: "AnonymousAuthResponse" });
