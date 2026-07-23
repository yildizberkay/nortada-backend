# 0010 — A linked device never re-bootstraps anonymously; the retired row remembers it

- **Status:** accepted
- **Date:** 2026-07-23
- **Scope:** nortada-backend (hardens RFC-0002; server-side counterpart of app ADR 0014)

## Context

RFC-0002 retires an anonymous user on link (branch 1: upgraded in place,
branch 2: merged into an existing Clerk row) and — until this record — freed
its `anonymousDeviceId` so the same device could re-bootstrap via
`POST /v1/auth/anonymous`. Two problems surfaced in review:

1. **The client crash window forks identities.** If the app dies between the
   server committing `/v1/auth/link` and the client persisting its new auth
   mode, the relaunched client is anonymous with revoked tokens; its refresh
   fails and it falls back to `/anonymous`, which silently mints a fresh,
   empty anonymous user for a device that owns a real account. No
   client-side heuristic can close this safely — only the server knows
   whether the link committed.
2. **App ADR 0014 ("anonymity is first-install only") was client discipline
   only.** The deviceId is client-generated and replayable; nothing
   server-side stopped a signed-out device from quietly becoming a new
   anonymous user again.

## Decision

`anonymousDeviceId` stays on the retired row as durable memory that the
device was linked. `POST /v1/auth/anonymous` distinguishes three cases:

- live anonymous row for the deviceId → reuse (unchanged, idempotent);
- retired row for the deviceId (upgraded: `isAnonymous = false`, or merged:
  `mergedIntoUserId` set) → **409 `ALREADY_EXISTS` /
  `AUTH_DEVICE_ALREADY_LINKED`**;
- no row → create (unchanged).

The live-device lookup additionally filters on `isAnonymous = true`: with
the deviceId now surviving a branch-1 upgrade, that filter is what keeps a
bare deviceId from ever minting anonymous-type tokens for a real account.

On 409 the client adopts the Clerk session it still holds (the
interrupted-link recovery) or gates on login. No schema change: the partial
unique index on `anonymous_device_id` keeps holding the retired row's slot,
which is exactly the point.

## Options considered

1. **Client-side heuristics** (refresh-rejected + live Clerk session ⇒ treat
   as linked) — every variant misfires in some rare path and converts a
   self-healing fork into silently stranded data.
2. **A separate `retired_device` table** — more machinery for the same
   memory; the retired user row already exists and already carries the id.
3. **Keep the id on the retired row and refuse re-bootstrap** — chosen.

## Evidence

- Crash-window fork analysis in the app repo, REMAINING-WORK §6
  (2026-07-23): fork is self-healing but violates ADR 0014's intent.
- Product call (Berkay, 2026-07-22, app ADR 0014): anonymity is a
  first-install-only ramp; an explicit exit leads to an explicit door back.

## Revisit when

- A sanctioned "demote to anonymous" flow appears (would need an explicit
  release of the retired deviceId).
- Device-transfer/restore flows (new phone, same Keychain) show legitimate
  re-bootstrap patterns being 409'd.
