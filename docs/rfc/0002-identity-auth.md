# RFC-0002: Identity & Authentication

|                |                                        |
| -------------- | -------------------------------------- |
| **RFC**        | 0002                                   |
| **Title**      | Identity & Authentication              |
| **Status**     | ✅ Completed                            |
| **Step**       | 1                                      |
| **Depends on** | RFC-0001                               |
| **Domain(s)**  | platform/auth                          |
| **Updated**    | 2026-07-11                             |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

---

## 1. Summary

This RFC gives every Nortada request a single, uniform identity. Two very different
credential sources feed one abstraction: **anonymous devices** carry a thin, device-bound JWT
that the `auth` domain mints and verifies itself (backed by an `is_anonymous` row in the
`user` table), while **signed-in users** carry a **Clerk** session token (native iOS/watchOS
_Sign in with Apple_ + email). A dual-source middleware verifies whichever token arrives and
sets `c.var.user: RequestUser`; downstream routes never learn which source authenticated the
caller. When a device signs in, its anonymous row is **linked/merged** into the Clerk account —
either upgraded in place or retired after its owned data is atomically reassigned to the
existing account.

The single most important design choice is the **split of responsibility** ([[decisions]]
D-002): Clerk owns the expensive, security-critical real logins (Apple server verification,
email/OTP, session/refresh rotation); we cheaply own the anonymous gap with our own HS256 JWT.
Anonymous users are deliberately **not** Clerk users — Clerk bills per MAU and has no native
anonymous concept, so millions of anonymous devices would be both costly and unsupported. The
second load-bearing choice is the **merge model** ([[decisions]] D-008): device-local
*preferences* are not carried across on merge, but real *owned data* (favorites, activities,
equipment) is moved inside **one transaction** via a per-domain `MergeReassigner` port.

## 2. Motivation & Context

- **Problem.** RFC-0001 shipped a running skeleton with an auth-middleware *placeholder* and no
  `user` table. Nothing can be user-scoped — profiles (RFC-0003), favorites (RFC-0004),
  activities (RFC-0006) — until there is an identity on every request. The product also requires
  that a user can start using the app instantly with **zero friction** (no login wall) and then
  optionally sign in later **without losing** the history they built while anonymous.
- **Background.** The pattern is lifted from the reference backend's `authenticate-app-jwt`
  design ([[reference/brandscale-architecture]] §11): one middleware, two token types, a uniform
  `c.var.user`. The stack decision (Clerk + our own thin anonymous JWT) is [[decisions]] D-002;
  the merge-reassign decision is [[decisions]] D-008. The full set of review-driven refinements
  is logged in [[../otonom-kararlar]] §13–§19 (and §22, where the merge seam was actually built
  with the first owned data). Product context: [[../NORTADA-OVERVIEW]].
- **Goals.**
  - A `user` table that holds anonymous devices and real Clerk logins in one shape, so
    `c.var.user` is uniform.
  - A stateless, **short-lived access + rotating refresh** low-privilege **anonymous JWT** system
    we sign/verify ourselves (D-009).
  - **Clerk** token verification, provisioning a `user` row on first sight.
  - A **dual-source** `authenticate` middleware and an optional-user context variant.
  - An **anonymous → Clerk link/merge** flow that never loses a user's real data and is safe
    under the concurrency an iOS cold-launch produces.
  - The three endpoints `POST /v1/auth/anonymous`, `POST /v1/auth/link`, `GET /v1/auth/me`.
- **Non-goals.** Profile fields and Clerk email/name hydration (RFC-0003), favorites (RFC-0004),
  activities (RFC-0006), subscription tier (RevenueCat, last), App Attest / device attestation
  (accepted in the request contract now, verified later), and any anonymous-row garbage
  collection.

## 3. Scope (In / Out)

- **In:** the `user` table (schema + `dbSchema` + inferred types); `AuthReason` error catalog;
  request/response Zod schemas; `UserRepository` (lookups, idempotent creates, the in-place
  upgrade, the `markMergedInto` retire, and the `transaction` wrapper); `ClerkService` (Clerk
  boundary, mockable); `AuthService` (issue/verify/link orchestration); the `authenticate`
  dual-source middleware and the `HonoContext<true>` optional-user variant; the IP-based
  `rateLimit` middleware; the `RequestUser` / `MergeReassigner` / `DBExecutor` types; the
  `auth.module.ts` wiring and its composition into `src/container.ts`; the `/v1/auth` routes.
- **Out:** profile domain and Clerk email/name hydration (RFC-0003); the *concrete* reassigners
  — this RFC ships the **seam** (`MergeReassigner[]` injected into `AuthService`), and the first
  real reassigner (`favoriteReassigner`) lands with RFC-0004, activities/equipment with RFC-0006;
  a distributed rate-limit store (in-memory single-instance for now); retired-row GC.

## 4. Domain Model & Ubiquitous Language

- **Identity (`user` row).** The single record for a principal. It is either **anonymous**
  (`isAnonymous = true`, `anonymousDeviceId` set, `clerkUserId` null) or **Clerk-backed**
  (`isAnonymous = false`, `clerkUserId` set). The same table holds both so `c.var.user` is
  uniform.
- **Anonymous device id.** A stable, device-scoped identifier the iOS app persists in the
  **Keychain** and sends to `/anonymous`. Same id ⇒ same anonymous `user` row (idempotent
  bootstrap), so a reinstall that keeps the Keychain entry keeps its history.
- **Anonymous access token.** A stateless HS256 JWT we mint, holding `sub = user.uid` and a
  `tokenType: "anonymous"` marker. **Short-lived (15 min)**, low-privilege (own data only); the
  client rotates it via a refresh token (D-009).
- **Refresh token.** An opaque high-entropy string (stored SHA-256 hashed) the client exchanges at
  `/refresh` for a new access token; rotated on every use, with family-based reuse detection.
- **Clerk identity.** The `{ clerkUserId, email? }` we extract from a verified Clerk session
  token. `clerkUserId` is Clerk's `sub`.
- **RequestUser (principal).** The request-context identity the middleware attaches to
  `c.var.user`: `{ id, uid, isAnonymous, clerkUserId, isAdmin }`. Distinct from the DB-inferred
  `User` row — routes read the principal; only `/me` returns the fuller row.
- **Link / Merge.** The act of attaching an anonymous identity to a Clerk account at sign-in.
  Two shapes: **upgrade-in-place** (same `user.id`, no Clerk row existed) and **merge-into-existing**
  (a Clerk row already exists; owned data is reassigned and the anonymous row is retired).
- **Retired row.** An anonymous `user` row whose `mergedIntoUserId` is set — it has been merged
  into a Clerk account. Its tokens must be rejected; it is never hard-deleted (audit + graceful
  rejection).
- **MergeReassigner (port).** A per-domain hook `(fromUserId, toUserId, tx) => Promise<void>`
  that moves one domain's user-owned rows during a merge. `auth` collects an array of them and
  runs them inside the merge transaction, so `auth` never imports a feature domain.

**Identity lifecycle (state machine):**

```
                       POST /anonymous (new device)
        (nothing) ───────────────────────────────► anonymous (live)
                                                        │
             POST /link + Clerk token                   │
        ┌───────────────────────────────────────────────┤
        │ branch 1: no Clerk row yet                     │ branch 2: Clerk row exists
        ▼                                                ▼
   Clerk-backed (same user.id,               anonymous → RETIRED (mergedIntoUserId set,
   upgraded in place)                        anonymousDeviceId freed); owned data moved
                                             to the existing Clerk row
```

## 5. Data Model (Drizzle)

Two tables (`src/db/schema.ts`): `user` (below) and `refresh_token` (§5.1, added with the D-009
token-rotation model). Both registered in `dbSchema` and exported (`User`/`NewUser`,
`RefreshToken`/`NewRefreshToken`).

| Column              | Type                         | Rationale                                                                                                   |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                | integer identity PK          | Internal key; never exposed (RFC-0001 `idColumn()`).                                                        |
| `uid`               | text uuid, unique, default   | Public opaque id; it is the anonymous JWT `sub`, and the only id surfaced in responses (`uidColumn()`).     |
| `clerkUserId`       | text, nullable               | Clerk `sub`. Null for anonymous rows. Unique **among non-null** via a partial index.                       |
| `isAnonymous`       | boolean, not null, default `true` | The uniform discriminator; flips to `false` on upgrade/provision.                                     |
| `anonymousDeviceId` | text, nullable               | The Keychain device id that owns this anonymous row. Unique **among non-null**. **Nulled on retire** so the device can re-bootstrap. |
| `email`             | text, nullable               | Best-effort from the Clerk token; usually null today (hydrated in RFC-0003, [[../otonom-kararlar]] §19).    |
| `displayName`       | text, nullable               | Same — populated later.                                                                                     |
| `isAdmin`           | boolean, not null, default `false` | Admin/moderator flag; gates spot moderation (RFC-0004) and future admin surfaces. Set **out-of-band**, never via the API. |
| `mergedIntoUserId`  | integer, nullable, **self-FK** → `user.id` | Set when *this* anonymous row was merged into another (Clerk) row. Non-null ⇒ retired ⇒ tokens rejected. Soft-retire (audit, not delete). |
| `createdAt`         | timestamptz(3), not null     | `createdAtColumn()`.                                                                                        |
| `updatedAt`         | timestamptz(3), not null     | `updatedAtColumn()` (`$onUpdateFn`).                                                                        |

**Indexes (and the query each serves):**

- `user_clerk_user_id_key` — `uniqueIndex(clerkUserId) WHERE clerkUserId IS NOT NULL`. A
  **partial** unique index: enforces one row per Clerk account while allowing many anonymous rows
  with a null `clerkUserId`. Serves `findByClerkUserId` (verify + link) and is the race guard
  that makes concurrent provisioning/upgrade collapse to one winner.
- `user_anonymous_device_id_key` — `uniqueIndex(anonymousDeviceId) WHERE anonymousDeviceId IS NOT NULL`.
  Partial unique: one live row per device, while retired rows (device id nulled) don't collide.
  Serves `findByAnonymousDeviceId`.
- `user_merged_into_user_id_idx` — plain index on `mergedIntoUserId`. Supports a future
  retired-row GC / audit sweep.

**Design notes.** The dual `id`/`uid` key follows the RFC-0001 convention: the JWT `sub` is the
opaque `uid` (not the integer `id`), so tokens never leak row ordering. Timestamps are
`timestamptz` UTC ([[../otonom-kararlar]] §6). The `user` table lives in `platform/auth` and is
the FK target for every user-owned table across the codebase (`user_profile`, `user_favorite`,
`activity`, …), which is exactly why it is `platform`, not `feature`. **Migration:** the base
tables are in the consolidated `0000` migration; the `refresh_token` table is the additive
`0001_fair_shiva.sql`. No backfill — tables are created empty.

### 5.1 `refresh_token` — access + refresh rotation (D-009)

Backs the short-lived-access + rotating-refresh model. Refresh tokens are stored **SHA-256
hashed** (the raw value exists only in transit and the client Keychain); Clerk sessions do **not**
use this table.

| Column           | Type                          | Rationale                                                                                     |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `id` / `uid`     | integer PK / text uuid        | RFC-0001 dual-key pattern.                                                                     |
| `userId`         | integer, not null, FK→`user.id` **ON DELETE CASCADE** | Owner; tokens die with the user.                                       |
| `tokenHash`      | text, not null, **unique**    | SHA-256 of the opaque token. Lookups are by hash; the raw token is never stored. Unique = the lookup key. |
| `familyId`       | text, not null                | Rotation lineage — all rotations descending from one login share it; the unit of reuse-revocation. |
| `expiresAt`      | timestamptz(3), not null      | 60-day refresh lifetime; checked on every `/refresh` and swept by the GC cron.                 |
| `revokedAt`      | timestamptz(3), nullable      | Set on rotation/revocation. A revoked token replayed = theft → the family is revoked.          |
| `replacedByHash` | text, nullable                | The hash that superseded this token on rotation (audit/lineage).                               |
| `createdAt`      | timestamptz(3), not null      | `createdAtColumn()`.                                                                            |

**Indexes:** `refresh_token_user_id_idx` (serves `revokeAllForUser` on link), `refresh_token_family_id_idx`
(serves `revokeFamily` reuse-revocation), `refresh_token_expires_at_idx` (serves the GC cron's
`expiresAt < now()` sweep). The rotation invariant (single-use) is enforced by a **conditional
atomic update** in the repository (`WHERE tokenHash = ? AND revokedAt IS NULL`, rowcount-checked),
not by an index — see §7.

## 6. API Surface (routes + OpenAPI)

Mounted at `/v1/auth` (`src/domains/index.ts` → `authRoute`). All responses use the RFC-0001
envelopes: success `{ data }` via `HTTPResponse.success`, error `{ error, reason?, message,
statusCode }` emitted centrally by the error-handler middleware.

| Method | Path                 | Auth              | Summary                                              |
| ------ | -------------------- | ----------------- | ---------------------------------------------------- |
| POST   | `/v1/auth/anonymous` | none (bootstrap)  | Find/create the device's anonymous row, mint a token pair |
| POST   | `/v1/auth/refresh`   | refresh token     | Rotate a refresh token into a new access + refresh pair |
| POST   | `/v1/auth/link`      | anonymous JWT     | Link the anonymous identity to a Clerk account       |
| GET    | `/v1/auth/me`        | anonymous OR Clerk | Return the current user                             |

**Token model (D-009, updated 2026-07-12):** `/anonymous` no longer returns a single 365-day
JWT. It returns a **short-lived access token (15 min)** + an **opaque refresh token (60 days)**,
and the client silently rotates via `/refresh` before the access token expires. See §7 for the
rotation + reuse-detection design and §9 for the token claims.

`/anonymous` and `/link` sit behind the IP-based `bootstrapRateLimit` (`keyPrefix:
"auth-bootstrap"`, `windowMs: 60_000`, `max: 20`); `/refresh` has its own bucket (`keyPrefix:
"auth-refresh"`, `max: 60`) since its legitimate cadence differs — see §10.

The response body maps a `User` through `toUserResponse` → `{ uid, isAnonymous, email,
displayName }` (deliberately narrow: no internal `id`, no `clerkUserId`, no `isAdmin`).

---

### `POST /v1/auth/anonymous`

- **Auth:** none. This is where a device gets its very first token, so it cannot require one.
  Rate-limited (§10).
- **Request (`json`, `anonymousAuthSchema`):**
  - `deviceId: string` — `min(8).max(256)`; the stable Keychain id.
  - `attestation?: string` — `max(8192)`; optional App Attest blob, accepted now so the client
    contract is stable, **verified in a later phase** ([[../otonom-kararlar]] §17).
- **Response (200, `AnonymousAuthResponse`):** `{ data: { accessToken, refreshToken, expiresIn,
  user } }` — `expiresIn` is the access-token lifetime in seconds (900); `user` is
  `UserResponse = { uid, isAnonymous, email, displayName }` (`email`/`displayName` nullable).
- **Errors:** `FORM_ERROR` (400) on validation; `RATE_LIMIT_EXCEEDED` (429) on abuse.

### `POST /v1/auth/refresh`

- **Auth:** none via the middleware — the refresh token **is** the credential (carried in the
  JSON body, never the URL). Rate-limited via `refreshRateLimit`.
- **Request (`json`, `refreshSchema`):** `refreshToken: string` (`min(1)`).
- **Response (200, `RefreshResponse`):** `{ data: { accessToken, refreshToken, expiresIn } }` —
  a **rotated** pair; the presented refresh token is now revoked.
- **Errors:** `UNAUTHENTICATED` (401) with `reason`:
  - `AUTH_REFRESH_TOKEN_INVALID` — unknown token, or its owning identity is gone/retired/upgraded.
  - `AUTH_REFRESH_TOKEN_EXPIRED` — past its 60-day expiry.
  - `AUTH_REFRESH_TOKEN_REUSED` — an already-rotated token was replayed (theft signal); the whole
    rotation family is revoked. The client should drop the token and re-bootstrap via `/anonymous`.
- **Example:**

  ```http
  POST /v1/auth/anonymous
  { "deviceId": "5F3A…keychain-uuid" }

  200 OK
  { "data": {
      "token": "eyJhbGciOiJIUzI1Ni> …",
      "user": { "uid": "8b1c…", "isAnonymous": true, "email": null, "displayName": null }
  } }
  ```

### `POST /v1/auth/link`

- **Auth:** anonymous JWT (the `authenticate` middleware runs; the anonymous identity is taken
  from `c.var.user`, **not** from the body). Rate-limited (§10).
- **Request (`json`, `linkSchema`):** `{ clerkToken: string }` — `min(1)`; a valid Clerk session
  token the client obtained from its Clerk SDK after Sign in with Apple / email.
- **Response (200, `UserResponse`):** `{ data: { uid, isAnonymous, email, displayName } }` — the
  resulting user (the upgraded row in branch 1, or the existing Clerk row in branch 2).
- **Errors:** `FORBIDDEN` / `AUTH_NOT_ANONYMOUS` (403) if the caller is already Clerk-backed;
  `ALREADY_EXISTS` / `AUTH_ALREADY_LINKED` (409) if this anonymous row is already retired;
  `UNAUTHENTICATED` / `AUTH_USER_NOT_FOUND` (401) if the principal's row is gone;
  `UNAUTHENTICATED` / `AUTH_INVALID_TOKEN` (401) if the Clerk token is bad/expired;
  `EXTERNAL_SERVICE_ERROR` / `AUTH_CLERK_UNAVAILABLE` (500) on a Clerk/JWKS outage;
  `RATE_LIMIT_EXCEEDED` (429); `INTERNAL_ERROR` (500) only if the link target cannot be resolved
  (should be unreachable).
- **Example:**

  ```http
  POST /v1/auth/link
  Authorization: Bearer <anonymous-jwt>
  { "clerkToken": "<clerk-session-token>" }

  200 OK
  { "data": { "uid": "8b1c…", "isAnonymous": false, "email": null, "displayName": null } }
  ```

### `GET /v1/auth/me`

- **Auth:** either token type (`authenticate`).
- **Request:** none.
- **Response (200, `UserResponse`):** `{ data: { uid, isAnonymous, email, displayName } }`.
- **Errors:** `UNAUTHENTICATED` with `AUTH_MISSING_TOKEN` (no/blank `Authorization`),
  `AUTH_INVALID_TOKEN` (malformed/bad token), `AUTH_ANONYMOUS_TOKEN_RETIRED` (merged row), or
  `AUTH_USER_NOT_FOUND` (row deleted since the token was minted) — all 401.

## 7. Services & Business Logic

Two services, both `extends BaseUseCase` (no DB handle — they read `this.config` and call the
repository/Clerk boundary). `AuthService` is the orchestrator; `ClerkService` is the thin,
mockable Clerk boundary.

### `AuthService`

Constructor: `(userRepository, refreshTokenRepository, clerkService, mergeReassigners:
MergeReassigner[] = [])`. The reassigners are injected at the composition root (§ container) so
`auth` never imports a feature domain.

- **`issueAnonymous(deviceId): { accessToken, refreshToken, expiresIn, user }`** —
  `findByAnonymousDeviceId(deviceId)` (live rows only), else `createAnonymous(deviceId)`; then
  `mintAccessToken(user)` (15 min JWT, §9) + create a refresh token in a **new** family
  (`randomUUID`). **Idempotent** on the device (same row, preserved history), but each bootstrap
  starts a fresh refresh family.
- **`refresh(rawRefreshToken): { accessToken, refreshToken, expiresIn }`** — the rotation entry
  point. Hash the presented token (SHA-256) → `findByHash`. Reject/branch, in order: not found ⇒
  `REFRESH_TOKEN_INVALID`; already `revokedAt` ⇒ **reuse/theft** ⇒ `revokeFamily` +
  `REFRESH_TOKEN_REUSED`; past `expiresAt` ⇒ `REFRESH_TOKEN_EXPIRED`; owner gone / retired
  (`mergedIntoUserId`) / **upgraded (`!isAnonymous`)** ⇒ `revokeFamily` + `REFRESH_TOKEN_INVALID`
  (the durable backstop that severs the anonymous refresh path post-link). Otherwise **rotate
  atomically** (`refreshTokenRepository.rotate`): a conditional `UPDATE … WHERE revokedAt IS NULL`
  revokes the old token and inserts a replacement in the **same family**; if the conditional
  matched no row, a concurrent `/refresh` already consumed it ⇒ treat as reuse (`revokeFamily` +
  `REFRESH_TOKEN_REUSED`). This conditional-update-with-rowcount is what makes single-use hold
  under concurrency (D-009).
- **`cleanupExpiredRefreshTokens(): number`** — maintenance method the GC cron (§8) calls;
  delegates to `deleteExpired()` (expired rows only; reuse tripwires preserved).
- **`authenticateToken(token): RequestUser`** — the dual-source entry point. `decodeJwt(token)`
  peeks the *unverified* claims (malformed ⇒ `UNAUTHENTICATED` / `INVALID_TOKEN`); if
  `tokenType === "anonymous"` it routes to `verifyAnonymous`, otherwise to `verifyClerk`. The
  peek is only a router — the actual signature is always verified on the chosen path.
- **`verifyAnonymous(token)`** — `jwtVerify` with the algorithm **pinned to HS256** and `issuer` /
  `audience` asserted; re-checks `tokenType`; requires `sub`; loads `findByUid(sub)`. A row with a
  non-null `mergedIntoUserId` is **retired** and rejected with `AUTH_ANONYMOUS_TOKEN_RETIRED`
  (the client must switch to its Clerk session). Any failure collapses to
  `UNAUTHENTICATED` / `INVALID_TOKEN` (no oracle about *why* the token failed).
- **`verifyClerk(token)`** — `clerkService.verifyToken(token)` → `{ clerkUserId, email? }`; if a
  row exists (`findByClerkUserId`) return it; otherwise **provision on first sight**
  (`createClerkUser`, idempotent). This covers a fresh device that signed in without ever calling
  `/anonymous`.
- **`getCurrentUser(principal): User`** — `findByUid(principal.uid)`; 401 `AUTH_USER_NOT_FOUND`
  if gone. Returns the fuller `User` row for `/me`.
- **`linkAnonymousToClerk(principal, clerkToken): User`** — the merge orchestration (below).

**Merge algorithm (`linkAnonymousToClerk`).**

1. **Guard the caller.** If `principal.isAnonymous` is false ⇒ `FORBIDDEN` / `NOT_ANONYMOUS`
   (only an anonymous session can be linked).
2. **Reload + guard the row.** `findByUid(principal.uid)`; missing ⇒ 401 `USER_NOT_FOUND`;
   already retired (`mergedIntoUserId !== null`) ⇒ `ALREADY_EXISTS` / `ALREADY_LINKED` (409) —
   idempotent rejection of a re-link.
3. **Verify Clerk.** `clerkService.verifyToken(clerkToken)` → identity. Look up
   `findByClerkUserId(identity.clerkUserId)`.
4. **Branch 1 — no pre-existing Clerk row: upgrade in place.**
   `tryUpgradeAnonymousToClerk(anonUser.id, { clerkUserId, email, displayName: null })` sets the
   Clerk fields, flips `isAnonymous = false`, and **nulls `anonymousDeviceId`** on the *same*
   row. Because the row's `id` is unchanged, everything already owned by it stays owned — no data
   movement needed. On success, **revoke the identity's anonymous refresh tokens**
   (`revokeAllForUser`) so the old anonymous refresh flow can't mint access tokens for the now-real
   account; the `!isAnonymous` backstop in `refresh()` makes this durable even if the revoke is
   missed. If this UPDATE hits the `clerk_user_id` partial-unique index (a concurrent `/link` just
   claimed it), the repo returns **`null`** instead of throwing, and we **fall through** to branch 2.
5. **Branch 2 — a Clerk row exists (or was just created by a racing request): reassign + retire.**
   Resolve the `target` (the existing row, or a re-read by `clerkUserId`); if still unresolved ⇒
   `INTERNAL_ERROR` (defensive, unreachable). Then, inside **one** `userRepository.transaction`:
   run **every** `MergeReassigner(anonUser.id, target.id, tx)` to move owned data,
   `revokeAllForUser(anonUser.id, tx)` to retire the anonymous session's refresh tokens, then
   `markMergedInto(anonUser.id, target.id, tx)` to retire the anonymous row and free its device
   id. One transaction ⇒ a partial failure never orphans or half-moves data (D-008). Return
   `target`.

**Invariants & edges.**
- **Idempotent bootstrap/provision:** `createAnonymous` / `createClerkUser` use `ON CONFLICT DO
  NOTHING` + re-read, so parallel first requests on cold launch converge on one row instead of a
  500 ([[../otonom-kararlar]] §15).
- **Link-race fallthrough:** the branch-1→branch-2 fallthrough on a unique violation means two
  simultaneous `/link` calls resolve deterministically, never 500 ([[../otonom-kararlar]] §15).
- **Retire frees the device:** `markMergedInto` nulls `anonymousDeviceId`, and
  `findByAnonymousDeviceId` filters `mergedIntoUserId IS NULL`, so a device that later signs out
  of Clerk can re-bootstrap a fresh live row instead of being trapped behind a retired token
  ([[../otonom-kararlar]] §16).
- **Atomic merge:** the reassign + retire run on the same `tx` executor (`DBExecutor`), the
  transactional seam D-008 was designed for.

### `ClerkService`

A thin wrapper over `@clerk/backend`'s `verifyToken`, isolated so the Clerk boundary is mockable.
Reads secrets at **call time** (`this.config.clerk`), not in the constructor. Verifies via
`secretKey` (Clerk's client fetches JWKS once per process and caches it), and passes
`authorizedParties` (azp) when configured. If the secret key is absent ⇒ `UNAUTHENTICATED` /
`CLERK_NOT_CONFIGURED`. The
critical logic is the **error split**: a `TokenVerificationError` whose reason is in
`INFRA_FAILURE_REASONS` (JWKS load/resolve/kid failures, `TokenVerificationFailed`,
`InvalidSecretKey`, …) — or any non-Clerk error (raw network failure) — becomes
`EXTERNAL_SERVICE_ERROR` / `CLERK_UNAVAILABLE` (5xx, **reported**); a genuine token problem
(expired/invalid) becomes `UNAUTHENTICATED` / `INVALID_TOKEN` (401, silent). Collapsing an outage
into a 401 would blind ops and trap users in a re-login loop ([[../otonom-kararlar]] §14).

### Middleware

`authenticate` (`src/middlewares/authenticate.middleware.ts`): extracts the `Bearer` token
(missing/malformed header ⇒ `UNAUTHENTICATED` / `MISSING_TOKEN`), calls
`authService.authenticateToken`, and sets `c.set("user", …)`. It re-throws `GenericError`
unchanged and maps any *unexpected* throwable to `INTERNAL_ERROR`, so a surprise never leaks as a
raw 500 without the central handler seeing it. `HonoContext<true>` (from `src/types.ts`) is the
optional-user context variant for routes where a user may be absent.

## 8. Background Jobs (Trigger.dev)

**`refresh-token-cleanup`** — a daily cron (`schedules.task`, `cron: "0 3 * * *"`) that deletes
**expired** refresh tokens so the `refresh_token` table and its hot `token_hash` index don't grow
unbounded as devices rotate every 15 min. It calls `authService.cleanupExpiredRefreshTokens()`
inside the standard Trigger lifecycle (`initializeForTrigger` + `createDBManagerForTrigger` +
`buildContainer` in `try`, `finalizeTrigger` in `finally`; `retry: 3`, `concurrencyLimit: 1`).
**Only `expiresAt < now()` rows are deleted** — revoked-but-unexpired rows are the reuse-detection
tripwires and are kept (D-009).

A future retired-*user*-row garbage collector (sweeping long-retired anonymous `user` rows via
`user_merged_into_user_id_idx`) remains a small deferred item ([[../otonom-kararlar]] §18).

## 9. Dependencies & Integrations

- **`@clerk/backend`** — `verifyToken` plus `TokenVerificationError` /
  `TokenVerificationErrorReason` (the reason enum drives the infra-vs-token split).
- **`jose`** — `SignJWT` / `jwtVerify` / `decodeJwt` for the anonymous HS256 token.

**Anonymous JWT claim set** (mint + assert):

| Claim       | Value            | Notes                                                            |
| ----------- | ---------------- | --------------------------------------------------------------- |
| `alg`       | `HS256`          | Pinned on verify (`algorithms: ["HS256"]`).                     |
| `sub`       | `user.uid`       | The public opaque id, never the integer PK.                     |
| `tokenType` | `"anonymous"`    | Custom claim; lets the middleware route without a verify round-trip. |
| `iss`       | `"nortada-anon"`  | Asserted on verify.                                             |
| `aud`       | `"nortada-api"`   | Asserted on verify.                                            |
| `iat`/`exp` | now / **15 min** | Short TTL (`ACCESS_TOKEN_TTL_SEC = 900`); the client rotates via `/refresh` before expiry (D-009). Verify uses a 10 s `clockTolerance` for NTP skew. |

**Env vars** (validated by `GlobalConfig`, RFC-0001 fail-fast):

| Var                          | Required           | Purpose                                                            |
| ---------------------------- | ------------------ | ----------------------------------------------------------------- |
| `AUTH_ANONYMOUS_JWT_SECRET`  | yes                | HS256 signing secret. **Prod gate:** must be ≥ 32 chars (a `superRefine`), relaxed inside the Trigger worker (`TRIGGER_WORKER=true`, which never signs tokens). |
| `CLERK_SECRET_KEY`           | optional           | Clerk API secret used for token verification.                     |
| `CLERK_PUBLISHABLE_KEY`      | optional           | Clerk publishable key (client-facing; carried for completeness).  |
| `CLERK_AUTHORIZED_PARTIES`   | optional           | Comma-separated azp allow-list; split/trimmed into `string[]`.    |

Clerk config is **optional** so local/dev can boot anonymous-only. iOS uses the Clerk iOS SDK's
`signInWithApple()` to obtain the `clerkToken` passed to `/link`.

**Seams exposed to later RFCs:** `RequestUser` + `HonoContext` (every later route reads
`c.var.user`); the `user` table as the universal FK target; and the `MergeReassigner[]` port that
data-owning domains plug into (RFC-0004 favorites, RFC-0006 activities/equipment).

## 10. Security & Privacy

- **Anonymous token posture.** Short-lived access token (15 min) + rotating refresh token (60 d,
  stored SHA-256 hashed), so a stolen access token is useful for minutes and a stolen refresh
  token is caught by reuse detection (D-009, §7). Still **low-privilege** (writes are user-scoped
  to its own data). Hardening: HS256 pinned on verify + `iss`/`aud` asserted, so a token minted
  with `AUTH_ANONYMOUS_JWT_SECRET` for some other purpose can't be mistaken for an auth token
  (defense-in-depth). Broad revocation lever: rotate the secret (invalidates all access tokens).
  Individual revocation: the `mergedIntoUserId` check on every verify retires a merged
  row's token ([[../otonom-kararlar]] §13).
- **Prod secret gate.** `AUTH_ANONYMOUS_JWT_SECRET` < 32 chars in prod fails config validation at
  boot — a short HS256 key signs forgeable device tokens.
- **Clerk token posture.** Short-lived + SDK-refreshed. Verification uses `secretKey` (JWKS is
  fetched once per process and cached by Clerk's client) and asserts azp when configured (the token
  was minted for *our* frontend). Infra failure ⇒ reported 5xx; bad token ⇒ silent 401
  ([[../otonom-kararlar]] §14).
- **Concurrency safety.** Provisioning and linking are idempotent under the parallel requests an
  iOS cold-launch produces: `ON CONFLICT DO NOTHING` + re-read on creates, and the branch-1→2
  fallthrough on the unique-index race — no 500s from `check-then-insert` ([[../otonom-kararlar]]
  §15). The pg `23505` detail stays *inside* the repository (`isUniqueViolation`) and never leaks
  to the service.
- **Retire hygiene.** A merged anonymous row's token dies with `AUTH_ANONYMOUS_TOKEN_RETIRED`, and
  its device id is freed so the device can re-bootstrap ([[../otonom-kararlar]] §16).
- **Rate limiting.** The unauthenticated `/anonymous` and `/link` endpoints are guarded by an
  IP-scoped fixed-window limiter (`rateLimit`, 60s / 20 req, `RATE_LIMIT_EXCEEDED` → 429).
  Without it, `/anonymous` is an unbounded INSERT + token-mint per unknown device id. The client
  IP is read from `x-forwarded-for` (Railway) with an `x-real-ip` / `"unknown"` fallback. **In-memory,
  single-instance only** — to be swapped for a Postgres/Redis store when the API scales out
  ([[../otonom-kararlar]] §17).
- **Data minimization.** `UserRepository` reads an **explicit column set** (never `SELECT *`), so a
  future sensitive column (e.g. a token hash) can't silently leak — it must be added deliberately.
  Responses go through `toUserResponse`, which omits the internal `id`, `clerkUserId`, and
  `isAdmin`.
- **PII.** `email`/`displayName` are the only PII, usually null until RFC-0003 hydration.
  `isAdmin` is never settable through the API — it is set out-of-band.
- **App Attest / attestation.** Accepted in the request contract now, verified in a later phase.

## 11. Observability

- **Central error policy (RFC-0001).** `GenericError` construction is pure — the error-handler
  middleware is the single place that decides report-vs-silent. `EXTERNAL_SERVICE_ERROR` (Clerk
  outage) and `INTERNAL_ERROR` are **reported as exceptions** (they should page); expected auth
  errors (`UNAUTHENTICATED`, `FORBIDDEN`, `ALREADY_EXISTS`, `RATE_LIMIT_EXCEEDED`) are returned to
  the client without reporting. This is exactly why the Clerk error split matters — an outage
  surfaces on dashboards, a bad token does not.
- **Machine-readable reasons.** Every failure carries an `AuthReason` (`AUTH_*`) so the client can
  branch (e.g. `AUTH_ANONYMOUS_TOKEN_RETIRED` → drop the anonymous token and use the Clerk
  session) and logs are greppable.
- **Middleware logging.** `authenticate` logs an `error`-level line for an *unexpected* auth
  failure (non-`GenericError`) before mapping it to `INTERNAL_ERROR`; expected `GenericError`s
  pass through untouched to the central handler.

## 12. Performance & Scalability

- **Hot path.** `authenticate` runs on nearly every request. Anonymous verify is a local HS256
  check + one indexed `findByUid` (unique on `uid`). Clerk verify fetches JWKS once per process
  and caches it in memory (a cold start pays one round-trip; steady state is local).
- **Index cost.** All auth lookups hit unique/partial-unique indexes (`uid`, `clerkUserId`,
  `anonymousDeviceId`) — O(log n) point reads. The merge transaction is small (a handful of
  UPDATEs) and rare (once per device per sign-in).
- **Statelessness.** Anonymous tokens are stateless (no server session store). The **one**
  intentional piece of process-local state is the in-memory rate-limiter map, explicitly flagged
  to move to a shared store when Nortada runs multiple instances ([[../otonom-kararlar]] §17). The
  limiter opportunistically sweeps expired buckets so memory stays bounded.
- **Deferred until it matters.** Retired-row GC and a distributed limiter are both deferred until
  scale demands them.

## 13. Testing Strategy

Co-located specs, all deps mocked (RFC-0001 test harness injects a mock config so services read
`this.config`).

- **`auth.service.spec.ts`** — `issueAnonymous` (idempotent reuse of a known device vs. create for
  a new one, asserting the signed token's `sub`/`tokenType`); `authenticateToken` (malformed
  token; valid anonymous → principal; **retired** anonymous → `ANONYMOUS_TOKEN_RETIRED`;
  wrong-secret anonymous → `INVALID_TOKEN`; existing Clerk user resolved *without* re-provision;
  Clerk user provisioned on first sight); `linkAnonymousToClerk` covering **all** paths
  (non-anonymous principal → `NOT_ANONYMOUS`; already-linked → `ALREADY_LINKED`; **branch 1**
  upgrade-in-place; **branch 2** reassign+retire, asserting the reassigner runs *before*
  `markMergedInto` on the same `tx`; and the **race fallthrough** where the branch-1 upgrade loses
  and the re-read finds the winner); `getCurrentUser` happy + missing. The transaction mock runs
  the callback inline with a fake executor so reassigner ordering is observable.
- **`clerk.service.spec.ts`** — verified identity (with/without `email`); `CLERK_NOT_CONFIGURED`
  when no key is set (and `verifyToken` not called); the **error split** — `TokenExpired` →
  `INVALID_TOKEN`, `RemoteJWKFailedToLoad` → `CLERK_UNAVAILABLE`, and a raw network error →
  `CLERK_UNAVAILABLE`; and that `secretKey` + `authorizedParties` are threaded into
  `verifyToken`.
- **Pre-ship gate (RFC-0001):** `lint:biome:fix`, `lint:type`, `lint:imports` (the
  `platform → feature` ban must hold — `auth` importing a feature domain would fail here), `test`.

## 14. Alternatives Considered

- **Make anonymous users real Clerk users.** Rejected — Clerk bills per MAU and has no native
  anonymous concept; millions of anonymous devices would be costly and unsupported. We own the
  thin anonymous JWT ourselves and let Clerk own the expensive real logins ([[decisions]] D-002).
- **Build all auth in-house (Apple server verification, email/OTP, session rotation).** Rejected —
  a large, never-ending security burden for a small team. Clerk absorbs the hardest, most
  security-sensitive parts.
- **Carry device-local preferences across a branch-2 merge.** Rejected — the target account's own
  profile should win (correct product behavior for a user who already set up elsewhere), and
  standing up a cross-domain transaction just to move *preferences* is premature. Only **real
  owned data** (favorites, activities) is moved; the orphaned anonymous `user_profile` row is
  harmless dead data cleaned up by a future GC ([[decisions]] D-008, [[../otonom-kararlar]] §18).
- **Collapse every Clerk verification failure to 401.** Rejected — it blinds ops during an outage
  and traps users in a re-login loop. The infra-vs-token split (5xx-reported vs 401-silent) is the
  chosen behavior ([[../otonom-kararlar]] §14).
- **Hard-delete the anonymous row on merge.** Rejected in favor of soft-retire
  (`mergedIntoUserId`) for audit and graceful token rejection; the device id is freed so the
  device can re-bootstrap.
- **Check-then-insert for provisioning.** Rejected — it races the partial-unique indexes under
  cold-launch parallelism and 500s. Replaced by idempotent `ON CONFLICT DO NOTHING` + re-read and
  the link-race fallthrough ([[../otonom-kararlar]] §15).
- **Switch provider entirely (Firebase Auth / Supabase Auth / Better Auth / Stytch).**
  Re-evaluated 2026-07-14 against the two product criteria (native iOS SDK + anonymous login) and
  rejected — full analysis in [[../decisions]] **D-010**. In short: Clerk's iOS SDK reached v1/GA
  (Feb 2026), removing the old "beta SDK" concern; Clerk still lacks anonymous users but our own
  anonymous JWT (this RFC) already closes that gap and keeps anonymous devices off provider MAU
  billing. Firebase Auth is the only candidate matching both criteria out of the box, but the
  migration would discard this implemented and reviewed auth domain for a Google-ecosystem
  lock-in; Supabase Auth cannot link anonymous→permanent through the native flow (browser
  redirect); Better Auth has no native Swift SDK; Stytch has no anonymous user model. Revisit
  when the Clerk bill becomes material at scale (trigger documented in D-010).

## 15. Implementation Plan (checklist)

1. ✅ `user` table in `src/db/schema.ts` (partial-unique indexes on `clerkUserId` /
   `anonymousDeviceId`, self-FK `mergedIntoUserId` + its index, `isAdmin`); add to `dbSchema`;
   export `User` / `NewUser`. `npm run db:gen`.
2. ✅ `platform/auth/errors.ts` — the `AuthReason` catalog.
3. ✅ `platform/auth/schemas/index.ts` — `anonymousAuthSchema`, `linkSchema`, and the
   `UserResponse` / `AnonymousAuthResponse` response schemas (`.describe()` + `.meta({ ref })`).
4. ✅ `repositories/user.repository.ts` — `findByUid` / `findByClerkUserId` /
   `findByAnonymousDeviceId` (live-only), idempotent `createAnonymous` / `createClerkUser`,
   `tryUpgradeAnonymousToClerk` (null on race), `markMergedInto` (retire + free device id),
   `transaction` wrapper; explicit column set + `isUniqueViolation` helper.
5. ✅ `services/clerk.service.ts` (+ spec) — `secretKey` verify + infra/token error split.
   *(2026-07-15: the optional networkless `jwtKey` path was removed — one verification path,
   less config; see [[../otonom-kararlar]] §14.)*
6. ✅ `services/auth.service.ts` (+ spec) — issue/verify/link orchestration, JWT constants +
   claim set.
7. ✅ `src/types.ts` — `RequestUser`, `MergeReassigner`, `HonoContext<true>` (and `DBExecutor` in
   `db.manager.ts`).
8. ✅ `middlewares/authenticate.middleware.ts` (dual-source → `c.var.user`) and
   `middlewares/rate-limit.middleware.ts` (IP fixed-window).
9. ✅ `routes/v1.ts` — `/anonymous`, `/link`, `/me` with `describeRoute` + rate-limit + auth +
   `zValidator`.
10. ✅ `auth.module.ts` — `createAuthModule({ db, mergeReassigners })`; compose into
    `src/container.ts` (built **after** data-owning domains so their reassigners can be threaded
    in); mount `/v1/auth` in `src/domains/index.ts`.
11. ✅ `lint:biome:fix` · `lint:type` · `lint:imports` · `test` green.

## 16. Open Questions & Resolved Decisions

- ~~Token model~~ → **short-lived access (15 min) + rotating refresh (60 d) + family-based reuse
  detection**, tokens hashed at rest; new `POST /v1/auth/refresh`; expired-token GC cron.
  **IMPLEMENTED** 2026-07-12 (Berkay decision 2026-07-11; [[decisions]] D-009, [[OPEN-DECISIONS]]).
  Two reviews hardened it: rotation made a conditional atomic update (single-use under
  concurrency), and the branch-1 link severance made durable via a `!isAnonymous` backstop in
  `refresh()`. Open follow-up: confirm the 15 min / 60 day TTLs with product. ✅
- ~~Anonymous JWT shape / revocation~~ → HS256, `sub=uid`, `tokenType`/`iss`/`aud`; revoke broadly
  via secret rotation, individually via `mergedIntoUserId` (and, for refresh, `revokeFamily` /
  `revokeAllForUser`) ([[../otonom-kararlar]] §13). ✅
- ~~Clerk verification hardening~~ → `authorizedParties` (azp) assertion; infra failures →
  reported 5xx, token failures → silent 401 ([[../otonom-kararlar]] §14; the `jwtKey` networkless
  path shipped there was later removed, 2026-07-15). ✅
- ~~Provisioning + link race conditions~~ → idempotent `ON CONFLICT DO NOTHING` + re-read; branch-1
  upgrade unique-conflict **falls through** to branch-2 — no 500s ([[../otonom-kararlar]] §15). ✅
- ~~Retired anonymous row traps the device~~ → `markMergedInto` also **frees `anonymousDeviceId`**,
  and `findByAnonymousDeviceId` returns live rows only, so a signed-out device re-bootstraps
  ([[../otonom-kararlar]] §16). ✅
- ~~No rate limit on the unauthenticated bootstrap endpoints~~ → IP fixed-window 60s/20 → 429 on
  `/anonymous` and `/link` ([[../otonom-kararlar]] §17). ✅
- ~~What data moves on merge~~ → **preferences don't move, real owned data does** — a per-domain
  `MergeReassigner` seam runs inside one transaction with `markMergedInto`. The seam went live with
  the first owned data (favorites, RFC-0004: `favoriteReassigner` + dedup `reassignOwner`);
  activities + equipment (RFC-0006) plug in the same way ([[decisions]] D-008,
  [[../otonom-kararlar]] §18, §22). ✅
- ~~Clerk email/displayName on provision~~ → the session token usually omits `email`, so these are
  null at provision; **RFC-0003** hydrates them from the Clerk User API
  ([[../otonom-kararlar]] §19). ⏸️
- Clerk email strategy (magic link vs OTP) — a Clerk dashboard config that doesn't touch our code.
  ⏸️
- Rate-limit store is in-memory (single instance); move to Postgres/Redis on scale-out
  ([[../otonom-kararlar]] §17). ⏸️
- App Attest / device attestation — accepted in the contract, verified in a later phase. ⏸️

## 17. References

[[decisions]] D-002 (Clerk + thin anonymous JWT) · [[decisions]] D-008 (merge: preferences vs
data) · [[../otonom-kararlar]] §13–§19, §22 · [[reference/brandscale-architecture]] §11
(`authenticate-app-jwt`) · [[0001-foundation]] (base classes, error/config plumbing, DI) ·
[[../NORTADA-OVERVIEW]]
