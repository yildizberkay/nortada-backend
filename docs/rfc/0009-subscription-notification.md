# RFC-0009: Subscriptions (RevenueCat) & Push Notifications (APNs)

|                |                                                              |
| -------------- | ------------------------------------------------------------ |
| **RFC**        | 0009                                                         |
| **Title**      | Subscriptions (RevenueCat) & Push Notifications (APNs)       |
| **Status**     | 🗓️ Deferred |
| **Step**       | 8                                                            |
| **Depends on** | RFC-0002                                                     |
| **Domain(s)**  | feature/subscription, platform/notification                  |
| **Updated**    | 2026-07-11                                                   |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected
> **Lifecycle:** set `🚧 In Progress` when implementation starts; `✅ Completed` when done. If a
> decision changes during implementation, update the RFC to match what was actually built.
>
> **This RFC is a forward-looking design proposal — nothing here is built yet.** It is written
> at the depth of an implementable spec so that when the monetization/notifications phase opens
> the work can begin without re-litigating structure. It is deliberately **deferred behind the
> RFC-0001…0006 build** (Berkay's decision, 2026-07-11: monetization and notifications land
> last — see [[README]] and §2/§16). It is scheduled at Step 8 but has no hard ordering
> dependency beyond RFC-0002 (identity); it may be built at any point after the core product is
> in place.

---

## 1. Summary

This RFC delivers the two "last" server surfaces the iOS app currently fakes: **paid
subscriptions** and **push notifications**. They ship together as one phase ("sell + notify")
but are two independent bounded pieces.

**(A) Subscriptions — `feature/subscription`.** [[RevenueCat]] is the subscription SDK and the
**single source of truth** for entitlement state ([[decisions]] D-002 chose RevenueCat over
brandscale's Polar). The client SDK talks to the stores; our backend never trusts the client
for "is this user premium". Instead RevenueCat pushes lifecycle events to a **webhook receiver**
(authenticated by a shared secret, made exactly-once by an event-id idempotency log), which
projects them into a `subscription` row per user. An **`EntitlementPort`** lets any service ask
`isPremium(userId)`, and premium features (advanced insights, richer alerts) gate on it in the
service layer.

**(B) Push notifications — `platform/notification`.** A `device_token` table holds each user's
[[APNs]] tokens; a `NotificationService` exposes a **send port** (`sendToUser`) that RFC-0008
alerts (and any future sender) call; delivery goes through an **APNs client behind a
`PushProvider` interface** in `src/packages/apns` — the same "infra client behind a port" shape
as `OpenMeteoClient` and `S3ObjectStorage`. Invalid/expired tokens are pruned from APNs
feedback (`410 Unregistered`), and every attempt is written to a `notification_log`.

The single most important design choice, stated once: **both integrations are server-authoritative
and idempotent.** Entitlement is decided from RevenueCat's webhooks (with a REST reconcile safety
net), not from a client claim; push delivery de-duplicates on a logical key and self-heals its
token set. Neither the client nor a replayed/duplicated upstream event can corrupt state.

> **Seam for RFC-0008.** The alerts RFC ([[0008-alerts]]) depends on the push infrastructure
> defined here: its evaluation cron calls the `NotificationPort` exposed by this RFC. That is why
> RFC-0008 lists `RFC-0009 (notification/push)` as a dependency. Alerts cannot be finished until
> the notification half of this RFC exists.

## 2. Motivation & Context

- **Problem.** In the app today ([[../SPLASH-OVERVIEW]] §3), both surfaces are stubs:
  - *Subscriptions:* `PaywallView.swift` is a **static UI** — no StoreKit, no RevenueCat; the
    "pro" lock is a pure client-side index check (`SpotDetailView.swift:760`, `index >=
    freeCount`). There is no server concept of a paying user, so no feature can be safely gated
    and no revenue event is recorded.
  - *Notifications:* there is **no push at all** — no `UNUserNotificationCenter` wiring, no
    device tokens, no send path. The alert rule model exists (`AlertModels.swift`) but has
    "no evaluation engine + no push" ([[../SPLASH-OVERVIEW]] §3 table).
- **Background.** The reference backend ([[reference/brandscale-architecture]]) already contains
  a webhook-driven subscription/entitlement pattern (it used Polar); we adopt the *shape* of it
  (verify → idempotent event log → project entitlement → port) and swap the provider to
  RevenueCat. Push is new to Splash but standard: token-based APNs. Product/monetization intent
  is in [[../SPLASH-OVERVIEW]] §5 and the design PRD; the identity model this builds on is
  [[0002-identity-auth]] (dual anonymous-JWT / Clerk auth, `c.var.user`).
- **Goals.**
  - A **RevenueCat webhook receiver** that verifies authenticity, is idempotent per event id,
    handles the full lifecycle (purchase, renewal, cancellation, grace/billing-retry, expiration,
    refund, product change, transfer), and keeps `subscription` correct under retries and
    out-of-order delivery.
  - A server-side **entitlement check** (`EntitlementPort.isPremium`) that feature services gate
    on — never the client.
  - A **device-token registry** (register/unregister) and a **notification send port** that
    RFC-0008 and future senders call, delivered via **token-based APNs**, with automatic pruning
    of dead tokens and a delivery log.
  - Both integrations behind swappable **ports** with co-located service tests that mock the
    external clients.
- **Non-goals.**
  - Paywall / purchase UI, StoreKit calls, offering/price fetching — that is the **client** (the
    RevenueCat SDK). The backend never initiates a purchase.
  - A credit / virtual-currency ledger or metered billing.
  - Non-push channels (email, SMS, WebSocket). APNs only for v1 (watchOS shares the APNs topic;
    Android/FCM is a future port, §14).
  - Alert **rules and evaluation** — those are [[0008-alerts]]; this RFC only provides the send
    port they consume.
  - In-app messaging, marketing campaign tooling.

## 3. Scope (In / Out)

- **In:**
  - `feature/subscription`: `subscription` + `subscription_event` tables; `POST
    /v1/webhooks/revenuecat` (shared-secret auth, idempotent); `GET /v1/me/subscription`;
    `SubscriptionService` (webhook ingest, state machine, entitlement projection);
    `EntitlementPort` for feature gating; optional `subscription-reconcile` cron (REST safety
    net); a `MergeReassigner` so anonymous subscriptions follow the user on anon→Clerk merge
    (D-008).
  - `platform/notification`: `device_token` + `notification_log` tables; `POST/DELETE
    /v1/me/device-tokens`; `DeviceTokenService`; `NotificationService` (send port) +
    `NotificationPort` exposed to other domains; `src/packages/apns` (`PushProvider` interface +
    `ApnsClient`); `notification-send` task (retryable delivery) + `device-token-prune` cron.
- **Out:**
  - Client paywall/StoreKit/RevenueCat-SDK integration (iOS app).
  - Alert rule CRUD + evaluation cron → [[0008-alerts]].
  - Premium *feature content* itself (what "advanced insights" contains) → [[0007-insights]] /
    the owning feature RFC; this RFC only provides the gate.
  - Android push / FCM, email/SMS.

## 4. Domain Model & Ubiquitous Language

**(A) Subscription**

- **App User ID.** RevenueCat's identifier for a customer. **We set it equal to our user
  `uid`** — the client calls `Purchases.logIn(user.uid)`, so RevenueCat's customer maps 1:1 to a
  Splash user. This is the join key on every webhook (`event.app_user_id`).
- **Entitlement.** A named capability grant (Splash has one: `pro`). RevenueCat decides whether
  an entitlement is active; we mirror its verdict. The entitlement id that grants premium is
  config (`REVENUECAT_PRO_ENTITLEMENT_ID`, default `"pro"`).
- **Product.** The store SKU behind an entitlement (e.g. `splash_pro_monthly`,
  `splash_pro_annual`). One entitlement can be served by several products.
- **Store.** Where the purchase lives: `app_store` (Apple, v1), plus `play_store`, `stripe`,
  `promotional`, `amazon` for forward-compatibility.
- **Subscription (our projection).** One row per `(userId, entitlementId)` holding the *current*
  derived state: `status`, `isActive`, `willRenew`, `expiresAt`, `store`, plus provenance
  (`lastEventId`, `lastEventAt`). This is what `isPremium` reads.
- **Subscription status — state machine** (mirrors RevenueCat lifecycle):

  ```
                     INITIAL_PURCHASE / NON_RENEWING_PURCHASE
        (none) ───────────────────────────────────────────────► active
          ▲                                                    │  │  ▲
          │ EXPIRATION (grace elapsed)                RENEWAL  │  │  │ UNCANCELLATION
          │                                     (extend expiry)│  │  │
       expired ◄──────────────── in_grace_period ◄────────────┘  │  │
          ▲                     ▲   BILLING_ISSUE                 │  │
          │ REFUND (revoke)     │   (grace_period_expiration)     │  │
          │                     └───── billing_retry              │  │
       refunded                                       CANCELLATION▼  │
          ▲                                    (auto-renew off,      │
          └──────────────────────── cancelled  still active to expiry)
  ```

  `isActive` (the thing `isPremium` returns) is the derived truth: **true** when
  `status ∈ {active, cancelled, in_grace_period, billing_retry}` **and** (`expiresAt` is null →
  lifetime, or `expiresAt > now`); **false** for `expired`, `refunded`, `paused`, `none`.
  `cancelled` still grants access until `expiresAt` (the user turned off auto-renew but paid
  through the period) — a common correctness bug we call out explicitly.

- **Webhook event.** A single RevenueCat lifecycle message (`{ api_version, event: { id, type,
  app_user_id, … } }`). `event.id` is globally unique and is our **idempotency key**.

**(B) Notification**

- **Device token.** An APNs token registered by one app install for one user. A token is unique
  to a device install; if the install re-registers under a different user (anonymous → login) the
  token **moves** to the new user.
- **APNs environment.** `sandbox` (TestFlight/dev builds) vs `production`. Sandbox tokens must be
  sent to the sandbox APNs host and vice-versa; the token carries its environment.
- **Notification.** A logical message to a user: `{ category, title, body, data }`. It fans out
  to that user's active tokens (usually 1–3).
- **Notification category.** `alert` (RFC-0008 wind match), `system`, `account`, `marketing`.
- **Delivery / notification log.** One row per (notification, token) send attempt with its APNs
  outcome. A `dedupeKey` makes a logical notification exactly-once (also used as the APNs
  `apns-collapse-id`).
- **Send port (`NotificationPort`).** `sendToUser(userId, message)` — the seam other domains call.
- **Push provider (`PushProvider`).** The infra abstraction over APNs; `ApnsClient` is the first
  implementation.

## 5. Data Model (Drizzle)

All tables follow the house pattern: internal `id` (integer identity PK, never exposed) + public
`uid` (opaque UUID), `timestamptz` (UTC), `jsonb` typed `.$type<JsonValue>()`. New enums + tables
+ relations + inferred types go in `src/db/schema.ts`; a migration is generated with `npm run
db:gen` (never auto-migrated in prod). No user-facing quantities here, so the SI-units rule
(D-006) is moot for this RFC.

**New enums**

```typescript
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active", "cancelled", "in_grace_period", "billing_retry",
  "expired", "paused", "refunded",
]);
export const subscriptionStoreEnum = pgEnum("subscription_store", [
  "app_store", "play_store", "stripe", "promotional", "amazon", "unknown",
]);
export const subscriptionEventStatusEnum = pgEnum("subscription_event_status", [
  "received", "processed", "ignored", "failed",
]);

export const pushPlatformEnum = pgEnum("push_platform", ["ios", "watchos", "android"]);
export const apnsEnvironmentEnum = pgEnum("apns_environment", ["sandbox", "production"]);
export const notificationCategoryEnum = pgEnum("notification_category", [
  "alert", "system", "account", "marketing",
]);
export const notificationStatusEnum = pgEnum("notification_status", [
  "queued", "sent", "failed", "invalid_token",
]);
```

### 5.1 `subscription` — the entitlement projection (one row per user × entitlement)

| Column | Type | Notes / rationale |
| ------ | ---- | ----------------- |
| `id` / `uid` | identity / uuid | house PK + public id. |
| `userId` | integer FK → `user.id` | `.notNull()`, `onDelete: "cascade"`. Owner. |
| `entitlementId` | text | RevenueCat entitlement (e.g. `pro`). Non-obvious: a user could hold several entitlements someday, so we key per entitlement, not per user. |
| `productId` | text nullable | last store SKU seen (upgrade/downgrade via `PRODUCT_CHANGE`). |
| `store` | `subscriptionStoreEnum` | which store owns the purchase. |
| `status` | `subscriptionStatusEnum` | the state-machine value (§4). |
| `isActive` | boolean | **denormalized** derived truth. Stored (not computed on read) so the hot-path `isPremium` is one indexed boolean read, and so a reconcile sweep can flip it. Recomputed on every event + by the reconcile cron. |
| `willRenew` | boolean | auto-renew status; drives `cancelled` vs `active`. |
| `environment` | `apnsEnvironmentEnum`-like text (`sandbox`/`production`) | RevenueCat `environment`. In prod we can refuse to grant on `sandbox` (config, §10). |
| `currentPeriodStartAt` | timestamptz nullable | last period start. |
| `expiresAt` | timestamptz nullable | entitlement expiry; **null = lifetime / non-renewing**. Core of `isActive`. |
| `gracePeriodExpiresAt` | timestamptz nullable | from `BILLING_ISSUE.grace_period_expiration_at_ms`; bounds `in_grace_period`. |
| `billingIssueDetectedAt` | timestamptz nullable | set on `BILLING_ISSUE`, cleared on `RENEWAL`. |
| `unsubscribeDetectedAt` | timestamptz nullable | set on `CANCELLATION`, cleared on `UNCANCELLATION`. |
| `originalPurchaseAt` | timestamptz nullable | first-ever purchase (LTV/analytics). |
| `rcAppUserId` | text | the RevenueCat `app_user_id` last seen (normally `= user.uid`; retained to trace `TRANSFER`/alias). |
| `lastEventId` | text | the `event.id` that last mutated this row (provenance). |
| `lastEventAt` | timestamptz | `event.event_timestamp_ms`. **Out-of-order guard:** never apply an event older than `lastEventAt`. |
| `createdAt` / `updatedAt` | timestamptz | house timestamps. |

- **Constraints/indexes:** `uniqueIndex(userId, entitlementId)` (the projection key & upsert
  target); `index(userId) where isActive` — but simpler: `index(userId)` serves `isPremium`.
  `index(expiresAt) where isActive` for the reconcile sweep (find active rows past expiry).
- **Relations:** `subscription.userId → user` (many-to-one).

### 5.2 `subscription_event` — raw event log / idempotency (append-only)

| Column | Type | Notes / rationale |
| ------ | ---- | ----------------- |
| `id` / `uid` | identity / uuid | house. |
| `eventId` | text | **`.unique()` — the idempotency key.** RevenueCat delivers at-least-once and retries non-2xx; a unique `event.id` turns processing into exactly-once (insert-on-conflict-do-nothing) and doubles as replay protection. |
| `eventType` | text | `INITIAL_PURCHASE`, `RENEWAL`, … Kept as **text, not an enum**, because RevenueCat adds event types over time; an unknown type must be storable, not a migration blocker. |
| `appUserId` | text | `event.app_user_id` as received. |
| `userId` | integer FK → `user.id` nullable | resolved owner (nullable: an event can arrive for an unknown/aliased id). |
| `environment` | text | `SANDBOX` / `PRODUCTION`. |
| `eventAt` | timestamptz | from `event_timestamp_ms`. |
| `status` | `subscriptionEventStatusEnum` | processing outcome (`received`→`processed`/`ignored`/`failed`). |
| `error` | text nullable | failure detail for `failed`. |
| `payload` | `jsonb().$type<JsonValue>()` | the **full verified event body** — audit, replay, and debugging. |
| `createdAt` | timestamptz | received-at. |

- **Constraints/indexes:** `unique(eventId)`; `index(appUserId, eventAt)`; `index(status) where
  status = 'failed'` for a retry/inspection query.
- **Retention:** append-only; a later housekeeping job may prune `processed` rows older than N
  months (payloads are the bulk). Not in scope now.

### 5.3 `device_token` — user-scoped APNs tokens

| Column | Type | Notes / rationale |
| ------ | ---- | ----------------- |
| `id` / `uid` | identity / uuid | house. |
| `userId` | integer FK → `user.id` | `.notNull()`, `onDelete: "cascade"`. Owner. |
| `token` | text | the APNs device token (hex). **`.unique()`** — a token identifies one install; re-registration under a new user reassigns `userId` (see §7). |
| `platform` | `pushPlatformEnum` | default `ios`; `watchos` future. |
| `environment` | `apnsEnvironmentEnum` | picks the APNs host (sandbox vs prod). |
| `appVersion` / `osVersion` / `deviceModel` | text nullable | diagnostics only. |
| `revokedAt` | timestamptz nullable | **soft-delete.** Set on user unregister or when APNs returns `410 Unregistered` / `BadDeviceToken`. Active = `revokedAt IS NULL`. Soft so the prune cron can hard-delete later and so we keep a short audit trail. |
| `lastUsedAt` | timestamptz nullable | last successful send or re-register. |
| `createdAt` / `updatedAt` | timestamptz | house. |

- **Constraints/indexes:** `unique(token)`; `index(userId) where revokedAt IS NULL` (the
  "send to all my devices" lookup).
- **Relations:** `device_token.userId → user`.

### 5.4 `notification_log` — one row per delivery attempt

| Column | Type | Notes / rationale |
| ------ | ---- | ----------------- |
| `id` / `uid` | identity / uuid | house. |
| `userId` | integer FK → `user.id` `.notNull()` | recipient. |
| `deviceTokenId` | integer FK → `device_token.id` nullable | which token (`onDelete: "set null"`); null if the user had no active token. |
| `category` | `notificationCategoryEnum` | drives priority/collapse defaults. |
| `title` / `body` | text | rendered content. |
| `data` | `jsonb().$type<JsonValue>()` | custom payload, e.g. `{ spotUid, alertUid }` for deep-linking. |
| `dedupeKey` | text nullable | logical idempotency (e.g. `alert:<ruleUid>:<windowStartIso>`); also sent as APNs `apns-collapse-id`. |
| `status` | `notificationStatusEnum` | `queued`→`sent`/`failed`/`invalid_token`. |
| `apnsId` | text nullable | the `apns-id` APNs returned (support/trace). |
| `error` | text nullable | APNs reason (`Unregistered`, `BadDeviceToken`, …). |
| `sentAt` | timestamptz nullable | success time. |
| `createdAt` | timestamptz | house. |

- **Constraints/indexes:** `index(userId, createdAt)`; `uniqueIndex(dedupeKey) where dedupeKey IS
  NOT NULL` — prevents a logical notification from being sent twice (the alert cron's re-run
  safety, complementing RFC-0008's own `lastFiredAt` debounce).
- **Scale note:** one row per (notification × token). If fan-out ever grows large we can split
  into `notification` (logical) + `notification_delivery` (per token); the single-table form is
  chosen for now because Splash volumes are small (§12).

### 5.5 Migration & ordering

One migration adds all four tables + enums. `subscription` and `device_token` FK `user` (RFC-0002,
already present), so there is no ordering hazard. No data backfill: both projections start empty
and fill from live events/registrations. Notify the team on `db:gen`; do not auto-migrate prod
(house rule).

## 6. API Surface (routes + OpenAPI)

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| POST | `/v1/webhooks/revenuecat` | **RevenueCat shared secret** (not our JWT) | Ingest a subscription lifecycle event |
| GET  | `/v1/me/subscription` | anonymous JWT / Clerk | Current user's entitlement state |
| POST | `/v1/me/device-tokens` | anonymous JWT / Clerk | Register (upsert) a device token |
| DELETE | `/v1/me/device-tokens/:token` | anonymous JWT / Clerk | Unregister (revoke) a device token |
| GET | `/v1/me/device-tokens` | anonymous JWT / Clerk | List my registered devices (optional) |

Routes follow house rules: `async (c)`, `c.req.valid(...)`, user via `c.var.user`, `{ data }`
success envelope, `describeRoute` with `operationId` + `tags`, response schemas carry
`.describe()` + `.meta({ ref })`. Mounting in `src/domains/index.ts`:

```typescript
app.route("/v1/webhooks", subscriptionWebhookRoute); // POST /revenuecat (webhook auth)
app.route("/v1/me", subscriptionRoute);              // GET  /subscription
app.route("/v1/me", deviceTokenRoute);               // POST/DELETE/GET /device-tokens
```

### 6.1 `POST /v1/webhooks/revenuecat`

- **Auth:** **not** the app JWT. A dedicated `revenueCatWebhookAuth` middleware verifies the
  `Authorization` header against `REVENUECAT_WEBHOOK_AUTH_TOKEN` with a **constant-time compare**
  (see §10 for why this is a shared secret, not a per-body HMAC). Missing/wrong → `401`
  `UNAUTHENTICATED`. The `authenticate` middleware is intentionally **not** applied.
- **Request:** the RevenueCat event body, validated with a *tolerant* Zod schema — we parse the
  fields we consume and keep the rest via `.passthrough()`/a `raw` capture so an unknown
  `event.type` or new field never rejects a valid event:

  ```jsonc
  { "api_version": "1.0",
    "event": { "id": "…", "type": "RENEWAL", "app_user_id": "usr_uid",
               "entitlement_ids": ["pro"], "product_id": "splash_pro_monthly",
               "store": "APP_STORE", "environment": "PRODUCTION",
               "purchased_at_ms": 1720000000000, "expiration_at_ms": 1722678400000 } }
  ```
- **Response:** always `200 { data: { received: true } }` on a valid, authenticated event —
  **including** duplicates and unknown types (we ack so RevenueCat stops retrying; the work is
  idempotent). Non-2xx is reserved for auth failure (`401`) and genuine ingest failures we *want*
  retried (`500`).
- **Errors:** `UNAUTHENTICATED` (401, bad secret); `FORM_ERROR` (400, unparseable body);
  `INTERNAL_ERROR` (500, DB failure → RevenueCat retries).
- **Example (duplicate):** a re-delivered `event.id` inserts nothing (unique conflict) and
  returns `200 { received: true }`.

### 6.2 `GET /v1/me/subscription`

- **Auth:** `authenticate` (anonymous JWT or Clerk). Anonymous users get a valid "free" answer.
- **Response** (`SubscriptionState`, `.meta({ ref: "SubscriptionState" })`):

  ```jsonc
  { "data": { "isPremium": true, "entitlement": "pro", "status": "active",
              "willRenew": true, "store": "app_store",
              "expiresAt": "2026-08-03T00:00:00.000Z", "isLifetime": false } }
  ```
  For a user with no subscription: `{ isPremium: false, entitlement: null, status: null,
  willRenew: false, store: null, expiresAt: null, isLifetime: false }`.
- **Note:** this endpoint is a **read of our projection**, not a call to RevenueCat and not a
  trust of the client's SDK cache. It exists so the app can reflect server truth (and so support
  can see it); gating decisions happen server-side regardless (§7).

### 6.3 `POST /v1/me/device-tokens`

- **Auth:** `authenticate`.
- **Request** (`RegisterDeviceTokenBody`): `{ token: string (hex, 32–200), platform?: "ios" |
  "watchos", environment: "sandbox" | "production", appVersion?, osVersion?, deviceModel? }`.
- **Response** (`DeviceToken`): the stored device (`uid`, `platform`, `environment`,
  `createdAt`). `200` on upsert (idempotent — registering the same token twice is fine).
- **Errors:** `FORM_ERROR` (400) on a malformed token.

### 6.4 `DELETE /v1/me/device-tokens/:token`

- **Auth:** `authenticate`. **Ownership-scoped:** revokes only if the token belongs to
  `c.var.user`; otherwise `NOT_FOUND` (404) — we do not reveal that a token exists under another
  user.
- **Response:** `200 { data: { revoked: true } }`.

## 7. Services & Business Logic

### 7.1 `SubscriptionService` (feature/subscription)

```typescript
class SubscriptionService extends BaseUseCase {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly subscriptionEventRepository: SubscriptionEventRepository,
    // optional REST client for the reconcile safety net (§8):
    private readonly revenueCat?: RevenueCatProvider,
  ) { super(); }

  handleWebhookEvent(event: RevenueCatEvent): Promise<void>;   // idempotent ingest
  getState(userId: number): Promise<SubscriptionState>;        // GET /me/subscription
  isPremium(userId: number): Promise<boolean>;                 // EntitlementPort
  getEntitlements(userId: number): Promise<EntitlementState>;  // EntitlementPort
  reconcileExpired(): Promise<{ flipped: number }>;            // reconcile cron
}
```

**`handleWebhookEvent` — the core flow (all in one transaction):**

1. **Idempotency gate.** `INSERT INTO subscription_event (eventId, …) ON CONFLICT (eventId) DO
   NOTHING`. If no row was inserted → we have seen this `event.id` → **return** (ack 200). This is
   the exactly-once guarantee under RevenueCat retries and any replay.
2. **Resolve user.** `app_user_id → user by uid`. If unknown: record the event with `userId = null`,
   `status = ignored`, and return (a purchase for a not-yet-synced/aliased id; the reconcile cron
   or a later event will catch up). Never create a user from a webhook.
3. **Out-of-order guard.** Load the current `subscription` row; if it exists and
   `row.lastEventAt >= event.eventAt`, mark the event `ignored` and return — an older event must
   never clobber newer state (RevenueCat does not guarantee ordering).
4. **Project the event** onto the row via the transition table below (upsert on
   `(userId, entitlementId)`), recomputing `isActive`, `expiresAt`, `willRenew`, and the grace/
   billing/unsubscribe timestamps. Set `lastEventId`, `lastEventAt`.
5. **Mark the event `processed`.**

Steps 1–5 run inside a single repository transaction so the event log and the projection can never
disagree (crash between them → the whole thing rolls back and RevenueCat retries).

**Event → state transition table:**

| RevenueCat `event.type` | Effect on `subscription` |
| ----------------------- | ------------------------ |
| `INITIAL_PURCHASE`, `NON_RENEWING_PURCHASE` | upsert `active`, set `expiresAt` (null for non-renewing lifetime), `willRenew = true`, `originalPurchaseAt`. |
| `RENEWAL` | `active`, extend `expiresAt`, clear `billingIssueDetectedAt` / `gracePeriodExpiresAt`. |
| `UNCANCELLATION` | `willRenew = true`, clear `unsubscribeDetectedAt` (stays `active`). |
| `CANCELLATION` | `willRenew = false`, set `unsubscribeDetectedAt`, `status = cancelled` — **still `isActive` until `expiresAt`.** |
| `PRODUCT_CHANGE` | update `productId` (upgrade/downgrade), `expiresAt`. |
| `BILLING_ISSUE` | `status = in_grace_period` if `grace_period_expiration_at_ms` present (set `gracePeriodExpiresAt`, still active), else `billing_retry`; set `billingIssueDetectedAt`. |
| `EXPIRATION` | `status = expired`, `isActive = false`. |
| `REFUND` | `status = refunded`, `isActive = false` — **revoke immediately** (chargeback/abuse). |
| `SUBSCRIPTION_PAUSED` | `status = paused`, `isActive = false`. |
| `TRANSFER` | move the entitlement from the old `app_user_id` to the new one (reassign `userId`); ties into D-008 (§10). |
| `SUBSCRIBER_ALIAS` (deprecated) | treat both ids as the same user. |
| *unknown type* | store the event (`ignored`), no projection change — forward-compatible. |

**`isPremium(userId)`** reads the single `subscription` row: `true` iff a row exists with
`entitlementId = REVENUECAT_PRO_ENTITLEMENT_ID`, `isActive = true`, and (in prod, unless
`REVENUECAT_ALLOW_SANDBOX_ENTITLEMENT`) `environment = 'production'`. It **never** consults the
client or RevenueCat live — projection only, so it is O(1) and offline-safe.

**Merge hook (D-008).** A subscription is *real user data*, so the module exposes a
`MergeReassigner` (`subscriptionRepository.reassignOwner(from, to, tx)`), collected at the
composition root like `favoriteReassigner`/`activityReassigner`. On anon→Clerk merge the row
follows the surviving user in the same transaction; independently, the client re-`logIn`s
RevenueCat with the surviving `uid`, and the resulting `TRANSFER` webhook reconciles the source of
truth. Belt and suspenders: immediate local consistency + eventual provider consistency.

### 7.2 Premium gating (`EntitlementPort`)

```typescript
export interface EntitlementPort {
  isPremium(userId: number): Promise<boolean>;
  getEntitlements(userId: number): Promise<EntitlementState>;
}
```

Feature services that gate premium capabilities (advanced insights [[0007-insights]], richer
alert quotas [[0008-alerts]]) receive this port at the composition root (exactly like weather
receives `spotPort`). Gating lives in the **service layer**, not routes, so it is uniform and
unit-testable:

```typescript
// inside a premium feature service
if (!(await this.entitlement.isPremium(userId))) {
  throw new GenericError("FORBIDDEN", { reason: SubscriptionReason.PREMIUM_REQUIRED });
}
```

`SubscriptionReason` (in `feature/subscription/errors.ts`) defines `PREMIUM_REQUIRED`. Because
subscription is a `feature/` domain, other `feature/` domains importing this port is an allowed
`feature → feature` edge; nothing in `platform/` depends on it.

### 7.3 `DeviceTokenService` (platform/notification)

```typescript
class DeviceTokenService extends BaseUseCase {
  constructor(private readonly deviceTokenRepository: DeviceTokenRepository) { super(); }
  register(user: RequestUser, input: RegisterInput): Promise<DeviceToken>;
  revoke(user: RequestUser, token: string): Promise<void>;
  list(user: RequestUser): Promise<DeviceToken[]>;
}
```

- **`register`** upserts on the unique `token`. If the token already exists under **another**
  user (the device logged in as someone new), it **reassigns** `userId` and clears `revokedAt` —
  a token belongs to whoever currently holds the install. Updates `environment`/diagnostics and
  `lastUsedAt`.
- **`revoke`** sets `revokedAt` only when the token is owned by the caller; otherwise `NOT_FOUND`.

### 7.4 `NotificationService` (platform/notification) — the send port

```typescript
class NotificationService extends BaseUseCase implements NotificationPort {
  constructor(
    private readonly deviceTokenRepository: DeviceTokenRepository,
    private readonly notificationLogRepository: NotificationLogRepository,
    private readonly push: PushProvider,               // src/packages/apns port
    private readonly preferences?: NotificationPrefPort, // RFC-0003 profile toggle (optional)
  ) { super(); }

  sendToUser(userId: number, message: NotificationMessage): Promise<SendResult>;
}
```

**`sendToUser` flow:**

1. **Consent/preference gate.** If the user disabled notifications (the app's notification toggle,
   surfaced from the RFC-0003 profile via `NotificationPrefPort`) and the category is not
   `account`/critical → skip, log nothing sent.
2. **Dedup.** If `message.dedupeKey` is set and a `notification_log` row with that key exists →
   return early (the alert cron re-ran; do not re-send). Enforced by the partial unique index.
3. **Fan out.** Load the user's active tokens (`revokedAt IS NULL`). For each: build the APNs
   payload (§9), write a `queued` log row, call `push.send(token, payload)`, then update the log
   with the outcome (§ table below). APNs HTTP/2 multiplexes, so the per-token loop is cheap.
4. **Self-heal.** On `410 Unregistered` / `BadDeviceToken`, revoke the token (`revokedAt = now`,
   log `invalid_token`). On transient errors (`429`/`5xx`), leave `queued`/`failed` for the
   `notification-send` task's retry.

**APNs response → outcome:**

| APNs status / reason | Log status | Action |
| -------------------- | ---------- | ------ |
| `200` | `sent` | record `apnsId`, `sentAt`, bump `device_token.lastUsedAt`. |
| `400 BadDeviceToken` / `BadTopic` / `DeviceTokenNotForTopic` | `invalid_token` | **revoke** token. |
| `403 InvalidProviderToken` / `ExpiredProviderToken` | `failed` | refresh the provider JWT; **report as exception** (misconfig — should page); retry. |
| `410 Unregistered` | `invalid_token` | **revoke** token (uses APNs `timestamp`). |
| `413 PayloadTooLarge` | `failed` | drop + log (a bug — payload too big). |
| `429 TooManyRequests`, `500`, `503` | `failed` (retryable) | back off, retry via task. |

**Cross-domain seam (RFC-0008).** `NotificationService` is exposed as `NotificationPort
{ sendToUser }` and passed to the alert module at the composition root. `platform → feature` is
forbidden, so notification (platform) must never import alert (feature); alert (feature) imports
the port type and calls it — an allowed `feature → platform` edge.

## 8. Background Jobs (Trigger.dev)

Tasks follow the house lifecycle: `initializeForTrigger()` + `createDBManagerForTrigger()` +
`buildContainer(db)` in `try`, `finalizeTrigger(db)` in `finally`, `Tracking.captureException`
on error. Invoked from services, never routes.

- **`notification-send` (`task`, retryable).** Payload `{ userId, message, dedupeKey? }`. Wraps
  `notificationService.sendToUser`. Retries transient APNs failures (`429`/`5xx`) with backoff so
  the *caller* (e.g. the RFC-0008 alert cron) stays fast and delivery is durable.
  `queue.concurrencyLimit` bounds APNs pressure; `maxAttempts ≈ 5`. The alert cron triggers one
  `notification-send` per matched user rather than sending inline. *(For very low volume, inline
  send inside the caller is also acceptable — the port lets us switch without touching callers.)*
- **`device-token-prune` (`schedules.task`, daily).** Hard-delete `device_token` rows with
  `revokedAt < now() - 30d` (soft-deleted long enough). Keeps the active set small and the "send
  to my devices" query fast. No payload; `concurrencyLimit: 1`.
- **`subscription-reconcile` (`schedules.task`, daily) — safety net.** Webhooks are the source of
  truth, but at-least-once delivery can *miss* (endpoint down during a retry window). This task:
  (a) flips `isActive = false` for rows whose `expiresAt < now()` (and grace elapsed) still marked
  active — a cheap defensive sweep needing no external call; and (b) *optionally*, if
  `REVENUECAT_API_KEY` is set, calls the RevenueCat REST API (`GET` subscriber) for a small set
  (recently expired / flagged) to repair drift. Idempotent; safe to re-run.

Subscription ingest itself is **webhook-driven, not a cron** — the receiver does the work
synchronously in the request (a single transaction), which is why the endpoint returns non-2xx
only when it wants a retry.

## 9. Dependencies & Integrations

**External services & env** (naming `{SERVICE}_{CREDENTIAL}`, matching `CLERK_*` / `OPEN_METEO_*`
/ `OBJECT_STORAGE_*`; declared in `src/env.d.ts` + validated in `global-config.ts`; optional at
boot so dev can run without them):

| Env var | Purpose |
| ------- | ------- |
| `REVENUECAT_WEBHOOK_AUTH_TOKEN` | Authorization-header shared secret set in the RevenueCat dashboard; required in prod. |
| `REVENUECAT_PRO_ENTITLEMENT_ID` | entitlement id that grants premium (default `"pro"`). |
| `REVENUECAT_ALLOW_SANDBOX_ENTITLEMENT` | `"true"/"false"` (default `"false"` in prod) — whether sandbox events grant access. |
| `REVENUECAT_API_KEY` | RevenueCat v2 REST secret key (optional; reconcile only). |
| `REVENUECAT_PROJECT_ID` | RevenueCat v2 project id (optional; reconcile only). |
| `APNS_KEY_ID` | `.p8` key id → APNs JWT `kid`. |
| `APNS_TEAM_ID` | Apple team id → APNs JWT `iss`. |
| `APNS_BUNDLE_ID` | app bundle id → `apns-topic`. |
| `APNS_PRIVATE_KEY` | the `.p8` ES256 private key (PEM contents; base64 in the env if needed). |
| `APNS_DEFAULT_ENVIRONMENT` | `"sandbox"/"production"` fallback host; per-token `environment` overrides. |

- **RevenueCat** — inbound webhook (primary) + optional outbound REST v2 (reconcile). The client
  RevenueCat SDK is the iOS app's concern (out of scope).
- **APNs** — token-based auth: a short-lived **ES256 JWT** signed with the `.p8` key (`{alg:
  ES256, kid}` header, `{iss, iat}` claims), sent as `authorization: bearer <jwt>` over **HTTP/2**
  to `api.push.apple.com` (prod) or `api.sandbox.push.apple.com` (sandbox), `POST /3/device/<token>`
  with `apns-topic`, `apns-push-type`, `apns-priority`, optional `apns-collapse-id`. The provider
  **caches and refreshes the JWT (~<60 min)** and reuses the HTTP/2 connection. Implemented as a
  package client (§ below); prefer a small maintained lib (`apns2`/`@parse/node-apn`) or `node:http2`
  + `jose`, hidden behind `PushProvider`.
- **RFC dependencies:** builds on RFC-0002 (identity, `c.var.user`, `MergeReassigner` seam).
  **Exposes** two seams for later RFCs: `EntitlementPort` (consumed by insights/alerts for
  gating) and `NotificationPort` (consumed by [[0008-alerts]] for push). RFC-0003's profile
  notification toggle is read through an optional `NotificationPrefPort`.

**Package: `src/packages/apns` (infra client behind a port)** — same shape as `open-meteo` /
`object-storage`:

```typescript
export interface ApnsPayload { aps: { alert?: { title: string; body: string };
  sound?: string; badge?: number; "content-available"?: 1 }; [k: string]: unknown; }
export type PushResult =
  | { ok: true; apnsId?: string }
  | { ok: false; retryable: boolean; invalidToken: boolean; reason: string };

/** Push transport contract. NotificationService depends on this, not on APNs. */
export interface PushProvider {
  send(token: string, env: "sandbox" | "production",
       payload: ApnsPayload, headers?: PushHeaders): Promise<PushResult>;
}

/** Token-based APNs (HTTP/2 + ES256 .p8 JWT). Config read lazily on first use so
 *  `new ApnsClient()` stays config-free (constructible at buildContainer time),
 *  matching OpenMeteoClient / S3ObjectStorage. */
export class ApnsClient implements PushProvider { /* … */ }
```

## 10. Security & Privacy

**(A) Subscriptions**

- **RevenueCat is the source of truth — never the client.** The SDK's client-side entitlement is
  UX only; every gate reads our `subscription` projection, fed exclusively by verified webhooks
  (+ REST reconcile). A jailbroken/modified client cannot grant itself premium.
- **Webhook authentication.** RevenueCat's documented mechanism is a **static `Authorization`
  header** you configure in its dashboard (it is *not* a per-body HMAC signature). We verify it
  with a **constant-time compare** against `REVENUECAT_WEBHOOK_AUTH_TOKEN`; mismatch → `401`. This
  nuance matters: because the secret is not bound to the body, we do **not** rely on the header
  alone for integrity — we layer:
  - **TLS** (the endpoint is HTTPS-only);
  - **Idempotency/replay protection** via the unique `event.id` (a captured-and-replayed request
    is a no-op);
  - **Out-of-order guard** via monotonic `eventAt` (an old event cannot roll state back);
  - *(optional)* an IP allowlist of RevenueCat's published ranges — noted, not depended on
    (ranges change).
  If RevenueCat later offers body signing, add HMAC verification over the **raw** body (capture it
  in the auth middleware before JSON parsing).
- **Identity binding & abuse.** The join key is `app_user_id = user.uid`; a webhook never creates
  or elevates a user, only projects onto an existing one. `TRANSFER`/alias events move an
  entitlement between ids and are reconciled with D-008 (a subscription follows the surviving user
  on merge, and RevenueCat's `TRANSFER` confirms it).
- **Sandbox isolation.** Sandbox events are stored but (in prod) do not grant entitlement unless
  `REVENUECAT_ALLOW_SANDBOX_ENTITLEMENT` is set — prevents TestFlight/sandbox purchases from
  unlocking prod for free.

**(B) Notifications**

- **Token ownership.** Register/revoke act only on `c.var.user`'s tokens; a token maps to one
  install and reassigns on login. Revoke is ownership-scoped (`NOT_FOUND` otherwise) — no
  cross-user token probing.
- **Consent.** The OS gates push permission; the app only registers a token after the user
  grants it, and the server additionally honors the per-user notification preference
  (`NotificationPrefPort`) before sending non-critical categories.
- **Sensitive data.** Device tokens are effectively targeting secrets: stored plainly (needed to
  send) but **never logged in full** — logs carry a truncated/hashed token only. Notification
  bodies (spot names, wind figures) are low-sensitivity; no PII beyond that. `.p8` key and the
  webhook secret live only in env, never in code or the DB.

## 11. Observability

- **Subscriptions.** Every webhook logs `{ eventId, type, appUserId, outcome }` at `info`;
  duplicates/unknown types log at `debug`. `EXTERNAL_SERVICE_ERROR` (RevenueCat REST reconcile
  failing) is **reported as an exception** (`Tracking`), as is a webhook that fails to persist
  (500). Entitlement **transitions** (activated / expired / refunded) are emitted as tracked
  events for the monetization funnel and can back a "active pro count" metric (derivable from
  `subscription WHERE isActive AND entitlementId = pro`). The `subscription_event` table is itself
  an audit log.
- **Notifications.** Each send writes a `notification_log` row (the primary observability
  surface). `403 InvalidProviderToken`/`ExpiredProviderToken` (APNs auth/config) **reports as an
  exception** — it means the `.p8`/topic/JWT is wrong and should page. `410`/`BadDeviceToken` is
  **expected** (prune, `debug` log, never paged). Useful metrics: send success rate, invalid-token
  (prune) rate, and the `device-token-prune` daily count.

## 12. Performance & Scalability

- **`isPremium`** is one indexed read on `subscription(userId)` returning a stored boolean — cheap
  enough to call per gated request without a cache. A short in-process TTL cache is a trivial
  later add if a hot path calls it repeatedly; not needed now.
- **Webhook ingest** is O(1): one insert (event log) + one upsert (projection) in a single
  transaction. RevenueCat volume for a solo/early app is low (tens–hundreds/day); the endpoint is
  not a hot path.
- **Push fan-out** is small: a user has 1–3 active tokens. APNs HTTP/2 multiplexes many `POST
  /3/device` calls over one reused connection with one cached JWT, so per-user cost is minimal.
  Broadcasts (RFC-0008 alert matches across users) fan out as one `notification-send` task per
  user under a Trigger concurrency limit — batched, retried, and isolated from the caller. Token
  pruning keeps the active-token index tight.
- **Deferred until it matters:** splitting `notification_log` into logical + per-delivery tables;
  a dedicated APNs connection pool / worker; caching `isPremium`. All are single-table/single-node
  friendly today and flagged for the multi-instance future.

## 13. Testing Strategy

Co-located `*.service.spec.ts` per house rule; all deps mocked (repositories, ports, the external
clients). Critical scenarios:

- **`subscription.service.spec.ts`** — idempotency (duplicate `event.id` → no projection change);
  each transition (purchase→active, renewal extends expiry, **cancellation stays active until
  expiry**, billing-issue→grace, expiration→expired, **refund→revoked immediately**,
  product-change); **out-of-order guard** (older `eventAt` ignored); unknown event type stored,
  not applied; unknown `app_user_id` ignored (no user created); `isPremium` truth table incl.
  lifetime (`expiresAt = null`) and sandbox gating; `reassignOwner` (D-008).
- **Webhook auth** — constant-time compare accepts the right secret, rejects wrong/missing (`401`).
- **`device-token.service.spec.ts`** — upsert idempotency, reassign-on-relogin, ownership-scoped
  revoke (`NOT_FOUND` for someone else's token).
- **`notification.service.spec.ts`** — fan-out over active tokens, `dedupeKey` short-circuit,
  `410`/`BadDeviceToken` → token revoked, preference gate skips, mock `PushProvider`.
- **`apns.client.spec.ts`** (packages) — ES256 JWT build (`kid`/`iss`/`iat`, refresh window),
  host routing by environment, status→`PushResult` mapping (410 → `invalidToken`, 429/5xx →
  `retryable`). HTTP/2 mocked.
- **Manual/integration before shipping:** one RevenueCat **sandbox** purchase end-to-end (webhook
  → `subscription` → `GET /me/subscription` → gate flips); one real APNs sandbox push to a
  TestFlight device; a forced `410` (stale token) confirming prune.

## 14. Alternatives Considered

- **RevenueCat webhook vs. polling REST.** Chosen: webhook (push) for near-real-time entitlement
  with a daily REST **reconcile** as a safety net. Polling alone adds latency and rate cost;
  webhook-only risks missed deliveries — the pair covers both.
- **RevenueCat vs. App Store Server Notifications / StoreKit 2 direct.** Chosen: RevenueCat
  ([[decisions]] D-002 context — it is already the client SDK). Direct ASSN would make us
  reimplement receipt validation and renewal tracking per store; RevenueCat unifies stores behind
  one webhook and one customer model.
- **APNs direct (token auth) vs. a push provider (FCM / OneSignal).** Chosen: direct APNs — iOS-only
  today, token auth is simple and vendor-neutral behind our `PushProvider` port. Revisit FCM as a
  second `PushProvider` implementation if/when Android lands (§3 non-goal). No extra vendor now.
- **APNs token (.p8) vs. certificate auth.** Chosen: token — no per-app cert expiry/rotation, one
  key across environments, simpler ops.
- **APNs raw `node:http2` vs. a library.** Recommend a small maintained lib behind the port for
  connection/JWT handling; raw `http2` + `jose` is an acceptable fallback. The port makes the
  choice reversible.
- **`device_token` unique on `token` vs. `(userId, token)`.** Chosen: unique on `token` — one
  install = one token; re-registration reassigns the owner (matches how a device that logs in
  should stop notifying the previous anonymous user).
- **Compute `isActive` on read vs. store it.** Chosen: store (denormalized) — makes `isPremium`
  a single boolean read and lets the reconcile cron flip stale rows without re-deriving.

## 15. Implementation Plan (checklist)

*Subscription and notification are independent; either order works. Both follow the "Adding a New
Domain" checklist ([[../CLAUDE]]).*

**Phase A — feature/subscription**
1. `src/db/schema.ts`: `subscription`, `subscription_event` tables + enums + relations + inferred
   types; `npm run db:gen`.
2. `feature/subscription/errors.ts` (`SubscriptionReason` incl. `PREMIUM_REQUIRED`).
3. `schemas/index.ts` (tolerant RevenueCat event schema; `SubscriptionState` response).
4. `repositories/subscription.repository.ts` + `subscription-event.repository.ts` (upsert,
   idempotent insert-on-conflict, `reassignOwner`, transactions).
5. `services/subscription.service.ts` (+ `.spec.ts`) — webhook state machine, `isPremium`,
   `getState`, `reconcileExpired`; define `EntitlementPort`.
6. `packages/…` REST client for reconcile (optional).
7. `tasks/subscription-reconcile.{task}.ts`.
8. `middlewares/revenuecat-webhook-auth.middleware.ts` (constant-time compare).
9. `routes/v1.ts` — `subscriptionWebhookRoute` (webhook auth) + `subscriptionRoute` (`/me/subscription`).
10. `subscription.module.ts` (returns `subscriptionService` + `EntitlementPort` + `subscriptionReassigner`);
    wire into `container.ts` (thread `entitlementPort` to gated modules, `subscriptionReassigner`
    into auth's `mergeReassigners`); register routes in `domains/index.ts`.

**Phase B — platform/notification**
11. `src/db/schema.ts`: `device_token`, `notification_log` + enums + relations; `db:gen`.
12. `packages/apns/index.ts` — `PushProvider` interface + `ApnsClient` (+ `apns.client.spec.ts`);
    env in `env.d.ts` + `global-config.ts`.
13. `platform/notification/errors.ts`; `schemas/index.ts` (register/revoke, `DeviceToken`).
14. `repositories/device-token.repository.ts` + `notification-log.repository.ts`.
15. `services/device-token.service.ts` (+ spec) and `services/notification.service.ts` (+ spec);
    define `NotificationPort`.
16. `tasks/notification-send.{schema,task}.ts` + `tasks/device-token-prune.task.ts`.
17. `routes/v1.ts` — `deviceTokenRoute`.
18. `notification.module.ts` (returns `notificationService`/`NotificationPort` +
    `deviceTokenService`); wire into `container.ts`; expose `NotificationPort` for [[0008-alerts]];
    register routes.
19. `npm run lint:biome:fix && lint:type && lint:imports && test`; run `convention-reviewer`.

## 16. Open Questions & Resolved Decisions

- **Deferral (resolved).** Monetization + notifications are the **last** phase (Berkay,
  2026-07-11); this RFC stays at design depth until the RFC-0001…0006 build is complete. ✅
- **Webhook auth exact header.** RevenueCat uses a configured `Authorization` value (shared
  secret), not a per-body HMAC — confirm the exact format (`Bearer …` vs raw) in the dashboard at
  build time, and add HMAC body verification **if** RevenueCat has since shipped signing. ❓
- **Sandbox entitlement in prod.** Grant or not? Defaulted to **not** granting
  (`REVENUECAT_ALLOW_SANDBOX_ENTITLEMENT=false`); needs a product confirmation. ❓
- **Subscription in anon→merge.** Recommend **both** a `MergeReassigner` (immediate local move,
  D-008) **and** reliance on RevenueCat `TRANSFER` (provider truth). Confirm the client
  re-`logIn`s RevenueCat with the surviving `uid` on merge. ⏸️
- **Notification preference source.** Which RFC-0003 field/flag gates sends (`NotificationPrefPort`
  contract)? Confirm when RFC-0003's profile is final. ❓
- **`notification_log` shape.** Single table now; split into logical + per-delivery only if
  broadcast fan-out grows (§12). ⏸️
- **watchOS push.** Shares the APNs topic; may need a separate token `platform`/handling — future. ⏸️
- **Multi-instance APNs.** JWT/connection are per-process; fine for one node. Revisit sharing/pooling
  when horizontally scaled ([[../otonom-kararlar]]). ⏸️

## 17. References

- App: `PaywallView.swift` (static paywall), `SpotDetailView.swift` (`index >= freeCount` client
  lock), `AlertModels.swift` (alert rules, no push).
- [[../SPLASH-OVERVIEW]] §3 (real-vs-stub table), §5 (monetization intent).
- [[decisions]] D-002 (RevenueCat; dual auth), D-008 (anon→merge reassign seam).
- [[0002-identity-auth]] (identity, `c.var.user`, `MergeReassigner`), [[0008-alerts]] (consumes
  the `NotificationPort`), [[0007-insights]] (consumes the `EntitlementPort`).
- [[reference/brandscale-architecture]] (webhook/subscription + infra-client-behind-a-port pattern).
- RevenueCat webhooks (event types, `BILLING_ISSUE.grace_period_expiration_at_ms`, `REFUND`,
  `TRANSFER`); Apple APNs token-based provider connection (ES256 `.p8`, HTTP/2, `410 Unregistered`).
