# RFC-0008: Condition Alerts

|                |                                      |
| -------------- | ------------------------------------ |
| **RFC**        | 0008                                 |
| **Title**      | Condition Alerts                     |
| **Status**     | 🗓️ Deferred |
| **Step**       | 7                                    |
| **Depends on** | RFC-0004 (spot), RFC-0005 (weather), RFC-0009 (notification) |
| **Domain(s)**  | feature/alerts                       |
| **Updated**    | 2026-07-11                           |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected
> **Lifecycle:** set `🚧 In Progress` when implementation starts; `✅ Completed` when done. If a
> decision changes during implementation, update the RFC to match what was actually built.

> **This is a forward-looking design, not an as-built record.** The alerts domain is **not yet
> implemented**. The whole domain is **deferred behind the RFC-0001 → RFC-0006 build** (Berkay's
> decision, 2026-07-11 — alerts and monetization come last; see [[../otonom-kararlar]] §0 and the
> [[README|RFC index]]). This document specifies *what will be built* and *why* so the phase can be
> executed without re-deciding structure. Wording is deliberately in the future tense.

---

## 1. Summary

Condition Alerts turns Splash's core "is today good?" verdict into a **push you receive without
opening the app**. A user subscribes a **favorited spot** and **one or more sports** to
good-condition alerts, optionally tightening the thresholds (minimum/maximum wind, gust ceiling,
allowed wind directions, minimum confidence) and constraining *when* they care (days of week,
time-of-day window) and *when not to be disturbed* (quiet hours). A scheduled job periodically
scans the upcoming forecast for each subscribed spot through the **RFC-0005 decision engine**, and
when a qualifying **"go" window** appears inside the user's lead-time horizon it enqueues a push
notification via the **RFC-0009 notification infrastructure**.

The single most important design choice is that **the alert never re-derives the verdict** — it
reuses `computeDecision` / `bestWindow` from RFC-0005 as the *baseline safety gate*, and a
subscription's thresholds may only **tighten** that gate, never loosen it. This keeps the
life-safety downgrades (offshore wind, thunderstorm, CAPE) centralized in one engine and impossible
for a user to switch off. Two supporting choices make the batch cheap and spam-free: evaluation
**fans out over distinct spots, not users** (so users who share a spot share one cached forecast,
mirroring the D-004 demand-driven cache), and de-duplication is **per opportunity (spot × sport ×
local day)** via a unique key on an `alert_delivery` log, so a window that drifts an hour between
runs is alerted **once**.

## 2. Motivation & Context

- **Problem.** The iOS app already ships an alert *rule model* (`AlertModels.swift`) but has **no
  evaluation engine and no push** — it is in-memory and resets on every launch
  ([[../SPLASH-OVERVIEW]] §3, "Alarms" row). The product's headline promise is telling a rider
  *when* to go out; an alert that pings them when their spot turns "go" is that promise made
  proactive. The PRD ranks alerts in the **top-2 monetization** surfaces (PRD §10.15).
- **Background.** This RFC sits on top of three finished/planned domains: **RFC-0004 (spot)** owns
  spots + favorites + the `shoreBearingDeg` used for side/on/off-shore analysis; **RFC-0005
  (weather)** owns the Open-Meteo forecast, the demand-driven cache (D-004), and the Go/Watch/Skip
  **decision engine** with per-sport wind bands and `bestWindow` (`src/domains/feature/weather/
  decision.ts`); **RFC-0009 (notification)** owns APNs push-token registration and
  `NotificationService.sendPush(userId, payload)`. Alerts is the first consumer that *composes* all
  three. Product framing: [[../SPLASH-OVERVIEW]]; cache philosophy: [[decisions]] D-004; threshold
  research: [[../otonom-kararlar]] §24; unit policy: [[decisions]] D-006.
- **Goals.**
  - A user-scoped `alert_subscription` (favorited spot + chosen sport(s) + optional threshold,
    day/time, and quiet-hour criteria) with full CRUD.
  - A periodic evaluation that matches upcoming forecast windows to each subscription's criteria,
    reusing RFC-0005's engine and RFC-0005's cache (never a fresh global fetch).
  - **Exactly-once-per-opportunity** delivery: an `alert_delivery` log with a unique
    `(subscription, window)` key that both prevents duplicate pushes and is the user-facing history.
  - Respect for **quiet hours** (defer, don't drop), **notification consent**, and (as a
    monetization gate) subscription tier.
  - A clean seam onto RFC-0009 push (this RFC *enqueues*; it does not build push transport).
- **Non-goals.**
  - **Building push transport** (APNs, token registry, retry) — that is RFC-0009; alerts depends on
    it through a narrow port.
  - **Real observed-station conditions** — Open-Meteo's "now" is a model nowcast, not an
    observation ([[weather-openmeteo-mapping]] §3). Alerts evaluate the *forecast*, not live obs.
  - **ML / probabilistic forecasting**, SMS/email channels, and multi-spot "best spot near me
    tonight" digests (possible future, out of scope here).
  - **Deciding the monetization tier boundary** (free vs. pro count) — flagged in §16; the code
    provides the enforcement seam regardless.

## 3. Scope (In / Out)

- **In:** the `feature/alerts` domain — `alert_subscription` + `alert_delivery` tables and enums;
  CRUD routes under `/v1/me/alerts` + a delivery-history route; `AlertSubscriptionService`
  (CRUD, ownership, validation) and `AlertEvaluationService` (the matching/dedup/quiet-hours/batch
  algorithm); the `alert-evaluate` Trigger.dev cron; the D-008 merge reassigner
  (`alertReassigner`); the ports onto spot (RFC-0004), weather (RFC-0005), and notification
  (RFC-0009).
- **Out:** push transport itself (RFC-0009); observed-station data (RFC-0005 backlog); the weather
  *forecast* and *cache* (RFC-0005 — alerts read through it); the paywall UI and RevenueCat
  entitlement sync (RFC-0009); "recently viewed" hot-set membership (RFC-0005 fast-follow).

## 4. Domain Model & Ubiquitous Language

- **Alert Subscription** (`alert_subscription`) — a user's standing request: *"tell me when
  **this favorited spot** turns good for **these sports**, under **these criteria**."* Owned by
  exactly one user; references exactly one spot; carries one or more sports. It is a **rule**, not
  an event. Lifecycle: `enabled ⇆ disabled` (soft toggle) → `deleted` (hard). A subscription only
  makes sense while its spot stays published and favorited (see §7 invariants).
- **Criteria** — the tunable predicate on a subscription: **threshold overrides** (`minWindMs`,
  `maxWindMs`, `maxGustMs`, `allowedDirections`, `minConfidence`, `minWindowHours`), **relevance
  filters** (`daysOfWeek`, `dayStartMinute`/`dayEndMinute`, `leadTimeHours`), and **quiet hours**
  (`quietStartMinute`/`quietEndMinute` + `timezone`). Null threshold fields fall back to the
  RFC-0005 per-sport engine defaults; null filter fields mean "no constraint".
- **Qualifying Window** — a contiguous run of forecast hours the RFC-0005 engine rates **`go`**
  for the chosen sport (its `bestWindow`), *and* which additionally satisfies the subscription's
  tightened criteria and relevance filters, *and* whose start lies within `leadTimeHours` of now.
  A window is the atomic thing we alert on.
- **Opportunity** — the *de-duplicated identity* of a window: `sport × spot × local calendar day`.
  A window that shifts by an hour between two evaluation runs is the **same opportunity** and must
  not be alerted twice. Encoded as the `windowKey` text on a delivery.
- **Alert Delivery** (`alert_delivery`) — the immutable log row written the first time an
  opportunity fires for a subscription. It is simultaneously the **idempotency guard** (unique
  `(subscription, windowKey)`), the **history feed** the app shows ("you were alerted Sat 08:00 →
  11:00, peak 24 kt"), and the **retry ledger** (`status`).
- **Hot set** — RFC-0005's set of spots kept warm by the weather cron (currently favorites, D-004).
  Alerted spots must be warm; §7/§8 explain how evaluation keeps them warm *as a side effect* of
  reading through the cache, closing the RFC-0005 §6 "hot set = favorites + active alarms" note.

Subscription state machine:

```
                 PATCH isEnabled=false
   ┌──────────┐ ───────────────────────▶ ┌──────────┐
   │ enabled  │                          │ disabled │
   │(evaluated│ ◀─────────────────────── │(skipped  │
   │ by cron) │  PATCH isEnabled=true     │ by cron) │
   └────┬─────┘                          └────┬─────┘
        │            DELETE / spot unpublished/unfavorited
        └──────────────────────────┬───────────────────┘
                                    ▼
                               (removed)
```

## 5. Data Model (Drizzle)

All new tables/enums live in `src/db/schema.ts` (single source of truth), follow the mandatory
`id` (integer identity, internal) + `uid` (text uuid, public) pattern, use `timestamptz(precision:3)`
UTC timestamps, and store all wind quantities in **canonical SI m/s** (D-006 — the client converts
knots→m/s on write and back on read). A migration is generated with `npm run db:gen`; no data
backfill is needed (both tables start empty).

### 5.1 Enums

```typescript
// ─── alerts enums (RFC-0008) ─────────────────────────────────────────────────
// Confidence is shared with the RFC-0005 decision engine (Confidence type). It is
// promoted to a pgEnum here so `minConfidence` can be a first-class column; the
// weather response keeps using the inline z.enum with the same members.
export const confidenceEnum = pgEnum("confidence", ["low", "medium", "high"]);

export const alertDeliveryStatusEnum = pgEnum("alert_delivery_status", [
  "pending",   // delivery row written, push not yet confirmed enqueued
  "sent",      // push handed off to RFC-0009
  "suppressed",// held back by quiet hours (will be retried after quiet hours end)
  "failed",    // enqueue failed after retries — surfaced in observability
]);
```

`sportEnum` and `compassDirectionEnum` already exist (RFC-0003/0004) and are **reused** — no new
sport/direction vocabulary is introduced.

### 5.2 `alert_subscription`

| Column | Type | Rationale |
| --- | --- | --- |
| `id` / `uid` | idColumn / uidColumn | Internal PK + public opaque id (only `uid` is in the API). |
| `userId` | integer FK → `user.id` | Owner. Every query is scoped by it. `onDelete` cascades from user removal. |
| `spotId` | integer FK → `watersport_spot.id` | The target spot. Must be a *published* spot the user has *favorited* (§7). |
| `sports` | `sportEnum[]` notNull | One or more chosen sports; each is evaluated independently. Must be a subset of the spot's `supportedSports`. |
| `isEnabled` | boolean notNull default true | Soft on/off; the cron skips disabled rows. |
| `minWindMs` | real, nullable | Threshold **override** — raises the "too light" floor above the engine default. Null → engine default. Canonical SI. |
| `maxWindMs` | real, nullable | Override — lowers the "too strong" ceiling. Null → engine default. |
| `maxGustMs` | real, nullable | Gust ceiling override. Null → engine default. |
| `allowedDirections` | `compassDirectionEnum[]`, nullable | If set, the forecast wind must blow **from** one of these 16-point sectors. Null → any direction (engine still applies offshore safety). |
| `minConfidence` | `confidenceEnum` notNull default `medium` | Suppress low-confidence (stale/gusty) windows. |
| `minWindowHours` | integer notNull default 1 | Require the `go` run to be at least this many hours long (filters flukey single-hour gusts). |
| `leadTimeHours` | integer notNull default 48 | Only alert when the window start is within this horizon (≤ forecast horizon, capped at 168). |
| `daysOfWeek` | `integer[]`, nullable | Relevance filter: `0=Mon … 6=Sun` (matches the app's `AlertModels` day encoding). Null → any day. |
| `dayStartMinute` / `dayEndMinute` | integer, nullable | Local minutes-from-midnight; the window must overlap `[start,end)`. Null → all day. |
| `quietStartMinute` / `quietEndMinute` | integer, nullable | Local quiet-hours band; a push whose *send time* falls inside is **deferred** (§7). Null → never quiet. |
| `timezone` | text, nullable | IANA zone (e.g. `Europe/Istanbul`) used to interpret `daysOfWeek`, day-window, and quiet hours. Null → fall back to the spot's derived local zone / UTC (§16 open question). |
| `criteria` | jsonb `.$type<JsonValue>()`, nullable | Forward-compat bag for per-sport overrides and future knobs, so we don't sprint-add columns. |
| `createdAt` / `updatedAt` | timestamptz | Audit. |

```typescript
export const alertSubscriptionTable = pgTable(
  "alert_subscription",
  {
    id: idColumn(),
    uid: uidColumn(),
    userId: integer("user_id").notNull().references(() => userTable.id),
    spotId: integer("spot_id").notNull().references(() => spotTable.id),
    sports: sportEnum("sports").array().notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    minWindMs: real("min_wind_ms"),
    maxWindMs: real("max_wind_ms"),
    maxGustMs: real("max_gust_ms"),
    allowedDirections: compassDirectionEnum("allowed_directions").array(),
    minConfidence: confidenceEnum("min_confidence").notNull().default("medium"),
    minWindowHours: integer("min_window_hours").notNull().default(1),
    leadTimeHours: integer("lead_time_hours").notNull().default(48),
    daysOfWeek: integer("days_of_week").array(),
    dayStartMinute: integer("day_start_minute"),
    dayEndMinute: integer("day_end_minute"),
    quietStartMinute: integer("quiet_start_minute"),
    quietEndMinute: integer("quiet_end_minute"),
    timezone: text("timezone"),
    criteria: jsonb("criteria").$type<JsonValue>(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    // The cron pulls enabled rows and groups by spot — index the hot path.
    index("alert_subscription_enabled_spot_idx").on(t.isEnabled, t.spotId),
    // User-scoped list + the D-008 dedup on reassign.
    index("alert_subscription_user_idx").on(t.userId),
  ],
);
export type AlertSubscription = typeof alertSubscriptionTable.$inferSelect;
export type NewAlertSubscription = typeof alertSubscriptionTable.$inferInsert;
```

> **Multiplicity.** One subscription = one spot + a *set* of sports (`sports[]`), not a row per
> (spot, sport). This matches the app's UX ("alert me for this spot") and keeps CRUD to one object;
> evaluation and de-dup still work per-sport because the delivery `windowKey` embeds the sport
> (§5.3). There is intentionally **no** DB-level uniqueness on `(userId, spotId)` — a power user may
> keep two subscriptions on one spot with different criteria; the service caps the count (§7/§10).

### 5.3 `alert_delivery`

The idempotency log **and** the history feed. The dedup key is the **opportunity**, not the raw
window, so a drifting window fires once.

| Column | Type | Rationale |
| --- | --- | --- |
| `id` / `uid` | idColumn / uidColumn | PK + public id (history rows are addressed by `uid`). |
| `subscriptionId` | integer FK → `alert_subscription.id`, `onDelete: "cascade"` | Deleting a subscription removes its history. |
| `userId` | integer FK → `user.id` | **Denormalized** so the history endpoint and per-user batching filter without a join. |
| `spotId` | integer FK → `watersport_spot.id` | Denormalized for history rendering (spot name via join at read). |
| `sport` | `sportEnum` notNull | The specific sport that qualified. |
| `windowKey` | text notNull | Opportunity identity: `` `${sport}:${localDate}` `` (localDate = window-start date in the subscription's zone). The dedup axis. |
| `windowStartAt` / `windowEndAt` | timestamptz | The concrete matched window (UTC). Shown in history; may differ slightly from a later run's window for the same opportunity. |
| `peakWindMs` | real notNull | Peak wind in the window (from `bestWindow.peakWindMs`) — the "peak 24 kt" line. |
| `confidence` | `confidenceEnum` notNull | Confidence at match time. |
| `status` | `alertDeliveryStatusEnum` notNull default `pending` | Lifecycle / retry ledger (§7). |
| `pushRef` | text, nullable | The RFC-0009 push/Trigger-run id, for tracing an individual notification. |
| `evaluatedAt` | timestamptz notNull | When the matching run wrote this row. |
| `sentAt` | timestamptz, nullable | When the push was enqueued/confirmed. |
| `createdAt` | timestamptz | Audit. |

```typescript
export const alertDeliveryTable = pgTable(
  "alert_delivery",
  {
    id: idColumn(),
    uid: uidColumn(),
    subscriptionId: integer("subscription_id")
      .notNull()
      .references(() => alertSubscriptionTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => userTable.id),
    spotId: integer("spot_id").notNull().references(() => spotTable.id),
    sport: sportEnum("sport").notNull(),
    windowKey: text("window_key").notNull(),
    windowStartAt: timestamp("window_start_at", { precision: 3, withTimezone: true }).notNull(),
    windowEndAt: timestamp("window_end_at", { precision: 3, withTimezone: true }).notNull(),
    peakWindMs: real("peak_wind_ms").notNull(),
    confidence: confidenceEnum("confidence").notNull(),
    status: alertDeliveryStatusEnum("status").notNull().default("pending"),
    pushRef: text("push_ref"),
    evaluatedAt: timestamp("evaluated_at", { precision: 3, withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { precision: 3, withTimezone: true }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    // THE duplicate guard — one delivery per subscription per opportunity.
    uniqueIndex("alert_delivery_subscription_window_key").on(t.subscriptionId, t.windowKey),
    // History feed: newest first, per user.
    index("alert_delivery_user_created_idx").on(t.userId, t.createdAt),
    // Reconcile sweep of pending/suppressed rows.
    index("alert_delivery_status_idx").on(t.status),
  ],
);
export type AlertDelivery = typeof alertDeliveryTable.$inferSelect;
export type NewAlertDelivery = typeof alertDeliveryTable.$inferInsert;
```

Both tables/enums are appended to the aggregated `dbSchema` and their inferred types re-exported via
`src/db/index.ts` as needed (checklist steps 2–3).

## 6. API Surface (routes + OpenAPI)

All routes are **user-scoped** and mount under `/v1/me/alerts` (registered in
`src/domains/index.ts`). Auth is the dual-auth `authenticate` middleware (anonymous JWT **or**
Clerk both resolve to `c.var.user`) — an anonymous user may hold alerts, but delivery additionally
requires a registered push token + consent (§10). Responses use the standard `{ data }` envelope;
errors use `{ error, reason?, message, statusCode }`.

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| GET | `/v1/me/alerts` | user | List the caller's alert subscriptions |
| POST | `/v1/me/alerts` | user | Create a subscription for a favorited spot + sport(s) |
| GET | `/v1/me/alerts/:uid` | user | Fetch one subscription |
| PATCH | `/v1/me/alerts/:uid` | user | Update criteria / toggle `isEnabled` |
| DELETE | `/v1/me/alerts/:uid` | user | Delete a subscription (cascades its deliveries) |
| GET | `/v1/me/alerts/history` | user | Paginated delivery history (`?subscriptionUid=&limit=&cursor=`) |

Zod request/response schemas live in `src/domains/feature/alerts/schemas/index.ts`; every response
schema carries `.describe()` + `.meta({ ref: "PascalCase" })`.

```typescript
// ── Requests ────────────────────────────────────────────────────────────────
const sport = z.enum(sportEnum.enumValues);
const compass = z.enum(compassDirectionEnum.enumValues);
const minuteOfDay = z.number().int().min(0).max(1439);

export const createAlertSchema = z
  .object({
    spotUid: z.string().uuid(),
    sports: z.array(sport).min(1),
    // All optional; omitted → engine defaults / no constraint.
    minWindMs: z.number().min(0).max(60).optional(),
    maxWindMs: z.number().min(0).max(60).optional(),
    maxGustMs: z.number().min(0).max(80).optional(),
    allowedDirections: z.array(compass).min(1).optional(),
    minConfidence: z.enum(["low", "medium", "high"]).default("medium"),
    minWindowHours: z.number().int().min(1).max(24).default(1),
    leadTimeHours: z.number().int().min(1).max(168).default(48),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    dayStartMinute: minuteOfDay.optional(),
    dayEndMinute: minuteOfDay.optional(),
    quietStartMinute: minuteOfDay.optional(),
    quietEndMinute: minuteOfDay.optional(),
    timezone: z.string().optional(), // validated against the IANA set in the service
  })
  // Cross-field guard: a min above a max is nonsense.
  .refine((v) => v.minWindMs == null || v.maxWindMs == null || v.minWindMs <= v.maxWindMs, {
    message: "minWindMs must not exceed maxWindMs",
  });

export const updateAlertSchema = createAlertSchema.partial(); // spotUid/sports also patchable
export const alertUidParamSchema = z.object({ uid: z.string().uuid() });
export const historyQuerySchema = z.object({
  subscriptionUid: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

// ── Responses ───────────────────────────────────────────────────────────────
export const alertSubscriptionResponseSchema = z
  .object({
    uid: z.string(),
    spotUid: z.string(),
    sports: z.array(sport),
    isEnabled: z.boolean(),
    minWindMs: z.number().nullable(),
    maxWindMs: z.number().nullable(),
    maxGustMs: z.number().nullable(),
    allowedDirections: z.array(compass).nullable(),
    minConfidence: z.enum(["low", "medium", "high"]),
    minWindowHours: z.number(),
    leadTimeHours: z.number(),
    daysOfWeek: z.array(z.number()).nullable(),
    dayStartMinute: z.number().nullable(),
    dayEndMinute: z.number().nullable(),
    quietStartMinute: z.number().nullable(),
    quietEndMinute: z.number().nullable(),
    timezone: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .describe("A user's good-condition alert subscription")
  .meta({ ref: "AlertSubscription" });

export const alertDeliveryResponseSchema = z
  .object({
    uid: z.string(),
    subscriptionUid: z.string(),
    spotUid: z.string(),
    spotName: z.string(),
    sport,
    windowStartAt: z.iso.datetime(),
    windowEndAt: z.iso.datetime(),
    peakWindMs: z.number(),
    confidence: z.enum(["low", "medium", "high"]),
    status: z.enum(["pending", "sent", "suppressed", "failed"]),
    sentAt: z.iso.datetime().nullable(),
  })
  .describe("A single fired alert (history row)")
  .meta({ ref: "AlertDelivery" });
```

**Per-endpoint notes.**

- **POST `/v1/me/alerts`** — validates that `spotUid` resolves to a *published* spot the caller has
  *favorited*, and that every entry in `sports` is in the spot's `supportedSports`. Errors:
  `NOT_FOUND` (spot / not favorited → 404), `FORM_ERROR` (sport unsupported, min>max, bad timezone →
  422), `ALREADY_EXISTS` (identical criteria on the same spot → **409**, Splash delta), and
  `FORBIDDEN`/`FORM_ERROR` when the subscription cap is hit (§10). Success → **201** `{ data:
  AlertSubscription }`.
- **PATCH `/v1/me/alerts/:uid`** — same validations for changed fields; `NOT_FOUND` if the row isn't
  the caller's (ownership is enforced by filtering on `userId`, so another user's `uid` is a 404,
  not a 403 — no existence oracle).
- **DELETE** — 204; idempotent-ish (404 if already gone).
- **GET `/v1/me/alerts/history`** — keyset pagination on `(createdAt, id)`; optional
  `subscriptionUid` filter; joins spot for `spotName`. Rows include `suppressed`/`failed` so the app
  can explain "we held this back during your quiet hours".

**Example — create.**

```
POST /v1/me/alerts
Authorization: Bearer <jwt>
{
  "spotUid": "3f2a…-alacati",
  "sports": ["windsurf", "wingfoil"],
  "minWindMs": 7.7,            // client converted 15 kt → m/s (D-006)
  "allowedDirections": ["N", "NNW", "NW"],
  "minConfidence": "medium",
  "leadTimeHours": 48,
  "daysOfWeek": [5, 6],         // Sat, Sun
  "quietStartMinute": 1320,     // 22:00
  "quietEndMinute": 420,        // 07:00
  "timezone": "Europe/Istanbul"
}

201 Created
{ "data": { "uid": "a1b2…", "spotUid": "3f2a…-alacati", "sports": ["windsurf","wingfoil"],
            "isEnabled": true, "minWindMs": 7.7, "maxWindMs": null, … } }
```

**Example — history.**

```
GET /v1/me/alerts/history?limit=2
200 OK
{ "data": [
  { "uid": "d9…", "subscriptionUid": "a1b2…", "spotUid": "3f2a…-alacati",
    "spotName": "Alaçatı", "sport": "windsurf",
    "windowStartAt": "2026-07-18T05:00:00.000Z", "windowEndAt": "2026-07-18T09:00:00.000Z",
    "peakWindMs": 12.3, "confidence": "high", "status": "sent",
    "sentAt": "2026-07-17T15:00:12.000Z" }
] }
```

## 7. Services & Business Logic

Two `BaseUseCase` services (no DB access — only `this.config`), each with dependencies injected via
the constructor (repos → other services/ports). All cross-domain calls go through **narrow ports**,
following the `WeatherSpotPort` pattern RFC-0005 established.

### 7.1 Ports (the seams onto other domains)

```typescript
// RFC-0004 spot slice alerts needs.
export interface AlertSpotPort {
  getGeoByUid(uid: string): Promise<SpotGeo>;          // name, coords, supportedSports, shoreBearingDeg
  isFavoritedByUser(userId: number, spotId: number): Promise<boolean>;
}

// RFC-0005 weather slice — the evaluable, cache-warm forecast for a spot+sport.
// Reads THROUGH the demand-driven cache (getOrFetch), so calling it keeps the
// spot warm (closes the RFC-0005 §6 "hot set = favorites + active alarms" note).
export interface AlertWeatherPort {
  getEvaluableForecast(spotUid: string, sport: Sport): Promise<{
    hourly: HourlySeries;                 // reused from decision.ts
    perHourDecision: Decision[];          // computeDecision per hour (safety already applied)
    stale: boolean;
  }>;
}

// RFC-0009 notification slice — enqueue only; transport/retry is RFC-0009.
export interface AlertNotificationPort {
  enqueuePush(userId: number, payload: PushPayload): Promise<{ pushRef: string } | null>;
  hasDeliverableTarget(userId: number): Promise<boolean>; // token registered + consent on
}

// RFC-0009 subscription slice — monetization gate (§10).
export interface AlertTierPort {
  maxAlerts(userId: number): Promise<number>; // e.g. free: 1, pro: Infinity
}
```

`WeatherService` will grow `getEvaluableForecast` (a thin wrapper over its existing
`getOrFetchForecast` + `computeDecision` loop — the same computation already backing
`getForecast`). This is the only additive change RFC-0005 needs.

### 7.2 `AlertSubscriptionService` (CRUD)

```typescript
class AlertSubscriptionService extends BaseUseCase {
  constructor(
    private readonly subscriptions: AlertSubscriptionRepository,
    private readonly spotPort: AlertSpotPort,
    private readonly tierPort: AlertTierPort,
  ) { super(); }

  list(userId: number): Promise<AlertSubscription[]>;
  get(userId: number, uid: string): Promise<AlertSubscription>;       // 404 if not owner
  create(userId: number, input: CreateAlertInput): Promise<AlertSubscription>;
  update(userId: number, uid: string, patch: PatchAlertInput): Promise<AlertSubscription>;
  delete(userId: number, uid: string): Promise<void>;
  listHistory(userId: number, q: HistoryQuery): Promise<Page<AlertDeliveryView>>;
}
```

**Invariants enforced on write:**

1. **Ownership** — every read/update/delete filters by `userId`; a foreign `uid` is a `NOT_FOUND`.
2. **Favorited + published spot** — `create` resolves the spot via `spotPort.getGeoByUid` and asserts
   `spotPort.isFavoritedByUser`; alerting a spot you don't follow makes no product sense and would
   also add a non-favorite to the hot set. If a spot is later unfavorited/unpublished, evaluation
   simply skips it (defensive; see §7.3) and the app can prompt cleanup.
3. **Supported sports** — every `sports[]` entry ∈ spot `supportedSports`, else `FORM_ERROR`.
4. **Sane thresholds** — `minWindMs ≤ maxWindMs`; minute fields 0–1439; `leadTimeHours ≤ 168`;
   `timezone` ∈ IANA set (validated with `Intl.supportedValuesOf('timeZone')`).
5. **Cap** — `count(userId) < tierPort.maxAlerts(userId)` (monetization gate; §10).

### 7.3 `AlertEvaluationService` (the engine)

Invoked **only** by the `alert-evaluate` cron (§8), never a route. The algorithm is deliberately
**spot-centric** to reuse each cached forecast across every user who watches that spot:

```
run(now):
  subs   = subscriptions.listEnabled()                     # single indexed scan
  bySpot = groupBy(subs, s => s.spotId)                    # fan out over SPOTS, not users
  matchesByUser = Map<userId, Match[]>

  for (spotId, spotSubs) in bySpot:
     spot = spotPort.getGeoByUid(spotUid)                  # skip if unpublished/missing
     sports = distinct(flatten(spotSubs.sports))           # only sports someone asked for
     for sport in sports:
        fc = weatherPort.getEvaluableForecast(spotUid, sport)   # cache-warm read
        windows = qualifyingWindows(fc, spot, sport, horizon=maxLead(spotSubs))
        for sub in spotSubs where sport in sub.sports:
           w = firstWindowSatisfying(windows, sub, spot, now) # thresholds + filters + lead
           if !w: continue
           key = windowKey(sport, w.start, sub.timezone)      # opportunity identity
           inserted = deliveries.tryInsert(sub, sport, w, key, now)  # ON CONFLICT DO NOTHING
           if !inserted: continue                             # already alerted → dedup
           matchesByUser.push(sub.userId, {sub, spot, sport, w, deliveryId})

  # Batch per user: one push per user per run, respecting quiet hours.
  for (userId, matches) in matchesByUser:
     if !notificationPort.hasDeliverableTarget(userId):
        deliveries.markFailed(matches, "no_target"); continue
     due, deferred = splitByQuietHours(matches, now)          # deferred = inside quiet band
     deliveries.markSuppressed(deferred)                      # retried next run after quiet ends
     if due.isEmpty(): continue
     payload = renderPush(userId, due)                        # "Alaçatı looks good — 2 spots"
     ref = notificationPort.enqueuePush(userId, payload)
     deliveries.markSent(due, ref)
```

**Key logic.**

- **Qualifying windows.** Start from the engine's `bestWindow`-style `go`-runs (safety downgrades
  already applied inside `computeDecision`). Then apply the subscription's **tightening** predicate
  hour-by-hour: `windMs ≥ minWindMs`, `windMs ≤ maxWindMs`, `gustMs ≤ maxGustMs`, wind sector ∈
  `allowedDirections` (forecast `windDirectionDeg` → nearest 16-point via a `geo` helper),
  `computeConfidence(...) ≥ minConfidence`, run length ≥ `minWindowHours`, and the run's local
  hours intersect `daysOfWeek` × `[dayStart,dayEnd)`. A subscription can only make the gate
  **stricter** — it can never turn a `watch`/`skip` hour into a match, so offshore/thunder/CAPE
  safety is inviolable.
- **Lead time.** Only windows with `start ∈ (now, now + leadTimeHours]` qualify — a heads-up, not a
  post-mortem. (An "it's good right now" reminder variant is a documented future, §16.)
- **De-duplication (idempotency).** The `deliveries.tryInsert` is an `INSERT … ON CONFLICT
  (subscription_id, window_key) DO NOTHING RETURNING id`. Because `windowKey = sport:localDate`, a
  window that drifts from 08:00 to 09:00 between runs collides and is **not** re-sent. The insert is
  the atomic guard even under the cron's `retry`/overlap: two concurrent inserts, only one wins.
- **Quiet hours = defer, not drop.** A match whose *intended send time* (now) is inside the quiet
  band is written with `status = suppressed` (dedup row still claimed, so no double-count) and
  **retried the next run once quiet hours end** — but only while the window is still in the future.
  This is the deliberate choice over silently dropping (users must not miss a good day because it
  surfaced at 03:00).
- **Per-user batching.** All of a user's matches in one run collapse into **one push** ("2 of your
  spots look good this weekend"), reducing notification fatigue, while each match still owns its
  delivery row for idempotency and history. If every match for a user was already delivered, no push
  is enqueued.
- **Failure isolation.** One spot's forecast fetch or one user's enqueue failing must **not** abort
  the batch (mirrors `WeatherService.refreshHotSet`): wrap per-spot and per-user bodies in
  try/catch, log, mark `failed`, continue.

### 7.4 Merge reassigner (D-008)

Alert subscriptions are *real user data*, so on anonymous→Clerk login they must move, not be lost.
The module returns an `alertReassigner: MergeReassigner` whose `reassignOwner(from, to, tx)` runs on
the auth merge transaction (like `favoriteReassigner`): re-point `alert_subscription.userId` and
`alert_delivery.userId` from → to. Deliveries carry no cross-user uniqueness, so they move wholesale;
subscriptions have no `(userId, spotId)` unique either, so no de-dup delete is needed (the count cap
is re-checked lazily on next write). Wired into `createAuthModule({ …, mergeReassigners: […,
alertReassigner] })` at the composition root.

## 8. Background Jobs (Trigger.dev)

One cron task, following the mandatory lifecycle (`initializeForTrigger()` +
`createDBManagerForTrigger()` + `buildContainer(db)` + `finally finalizeTrigger()`), invoked from
the service graph, never a route. Files: `tasks/alert-evaluate.{schema,task,trigger}.ts` (the
schema file is trivial — a schedule task takes no payload).

```typescript
export const alertEvaluateTask = schedules.task({
  id: "alert-evaluate",
  cron: "*/15 * * * *",          // every 15 min — finer than weather's 30, so a fresh
                                 // model run is acted on within a quarter hour
  maxDuration: 300,
  retry: { maxAttempts: 3 },     // safe: dedup makes a retried run idempotent
  queue: { concurrencyLimit: 1 },// no overlapping runs — the unique key is the real guard,
                                 // but serial runs keep the batch reasoning simple
  run: async () => {
    initializeForTrigger();
    const db = await createDBManagerForTrigger();
    try {
      const { alertEvaluationService } = buildContainer(db);
      const result = await alertEvaluationService.run(new Date());
      logger.info("Alerts evaluated", result); // {subs, spots, matched, sent, suppressed, deduped}
      return result;
    } catch (error) {
      Tracking.captureException(error, undefined, { taskId: "alert-evaluate" });
      throw error;
    } finally {
      await finalizeTrigger(db);
    }
  },
});
```

- **Idempotency / recompute story.** A run is fully idempotent: matching is recomputed from the
  cached forecast every time, and the `alert_delivery` unique key absorbs any re-fire. A crash after
  claiming a delivery row but before enqueue leaves it `pending`/`suppressed`; the next run's
  reconcile step re-enqueues rows still `pending` (or `suppressed` past quiet hours) whose window is
  still future, then abandons rows whose window has passed. Trigger's own `retry` therefore never
  causes a double push.
- **Cadence vs. cost.** Reading through the weather cache means a 15-min cron rarely calls
  Open-Meteo — the forecast TTL is 1h (RFC-0005), so ~3 in 4 runs are pure cache hits. Because
  evaluation reads every subscribed spot, it *keeps alerted spots warm as a side effect*, which is
  exactly the "active alarms" half of the RFC-0005 hot set (D-004) — no separate hot-set plumbing is
  required (chosen over feeding subscribed spots into the weather cron, which would create a
  spot↔alerts module cycle; §14).
- **Quiet-hours cadence.** The 15-min tick is also what lets a *deferred* (quiet-hours) alert go out
  promptly at the top of the hour after the band ends.

## 9. Dependencies & Integrations

- **RFC-0004 (spot).** `AlertSpotPort` — `getGeoByUid`, `isFavoritedByUser`. `SpotService` /
  `FavoriteService` satisfy it. Alerts also relies on `shoreBearingDeg` (for direction matching) and
  the favorite table (subscribed spots ⊆ favorited spots).
- **RFC-0005 (weather).** `AlertWeatherPort.getEvaluableForecast` — a thin new method on
  `WeatherService` over its existing cache + `computeDecision`/`bestWindow`/`computeConfidence`. This
  RFC reuses the engine wholesale; it does **not** duplicate thresholds. The default per-sport bands
  live in `decision.ts` ([[../otonom-kararlar]] §24); a subscription only overrides them.
- **RFC-0009 (notification + subscription).** `AlertNotificationPort.enqueuePush` /
  `hasDeliverableTarget` over `NotificationService`; `AlertTierPort.maxAlerts` over
  `SubscriptionService`. Push transport (APNs, token registry) and entitlement sync are entirely
  RFC-0009's; alerts is a pure consumer.
- **External services:** none new. Weather (Open-Meteo) and push (APNs) are reached only indirectly.
- **Env:** no new credentials. Optional tuning knobs (validated by `GlobalConfig`, read via
  `this.config`): `ALERTS_EVAL_CRON` (default `*/15 * * * *`), `ALERTS_DEFAULT_LEAD_HOURS`
  (default 48), `ALERTS_MAX_PER_USER_FREE` (default 1). Following the
  `{NAMESPACE}_{SERVICE}_{CREDENTIAL}` convention these would be `ALERTS_*`.
- **Seams this RFC exposes for later:** the `alert_delivery` feed (analytics on "alerts that
  actually led to sessions" once RFC-0006 activity + RFC-0007 insights want it); the
  `AlertWeatherPort` shape (a template for any future "watch this forecast" feature).

## 10. Security & Privacy

- **User-scoping.** Every subscription/delivery query is filtered by `c.var.user.id`. A foreign
  `uid` returns `NOT_FOUND` (not `FORBIDDEN`) so the API is not an existence oracle for other users'
  rows. Ownership is never inferred from the URL alone.
- **Notification consent.** A push is only enqueued when `hasDeliverableTarget(userId)` is true — a
  registered APNs token (RFC-0009) **and** the user's notifications-enabled flag. Creating a
  subscription is allowed without a token (the rule is standing), but delivery is gated; the history
  row records `failed:no_target` so the app can prompt the user to enable notifications.
- **Monetization gate.** Alerts are a top-2 paid surface (PRD §10.15). `AlertTierPort.maxAlerts`
  enforces the free/pro boundary **server-side** on `create` — the client entitlement is never
  trusted (mirrors RFC-0009 "entitlement verified server-side"). The exact free count is an open
  policy question (§16); the seam is built regardless.
- **Input hardening.** All criteria are Zod-validated with hard bounds (wind ≤ 60 m/s, gust ≤ 80,
  minutes 0–1439, lead ≤ 168 h, `sports` non-empty and ⊆ supported); timezone checked against the
  IANA set. Thresholds can only *tighten* the safety gate — a user can never construct a
  subscription that alerts on an offshore-gale or thunderstorm hour.
- **Rate limiting.** `POST/PATCH /v1/me/alerts` are user-rate-limited (RFC-0002 middleware) to
  prevent subscription churn; the count cap bounds fan-out cost.
- **PII.** No new PII — a subscription is a spot id + sport + thresholds tied to a user id. Push
  payloads contain only spot name + conditions, never location history.
- **Abuse surface.** Because subscribed spots must be favorited and the count is capped, a user
  cannot use alerts to force unbounded Open-Meteo fan-out (the cost stays inside the D-004 hot set).

## 11. Observability

- **Per-run summary** (info): `{ subscriptions, spots, sportsEvaluated, matched, sent, suppressed,
  deduped, failed, cacheHits, providerCalls, durationMs }` — the health signal for the cron.
- **Reported as exceptions** (they should page): the whole run throwing, a weather-port fetch
  failure that isn't the graceful stale-cache path, and any `enqueuePush` transport error surfaced
  by RFC-0009. Per-spot / per-user failures are **logged (warn) and counted**, not reported — one
  bad spot must not page (same policy as `refreshHotSet` and the centralized error-handler in
  RFC-0001).
- **Events (tracked, not exceptions):** `alert_fired` (on `markSent`, with sport, lead hours,
  peakWindMs, confidence), `alert_suppressed_quiet`, `alert_deduped`, `alert_no_target`. These feed
  a future "alert → session" conversion metric (does an alert actually get people on the water?).
- **Delivery table as audit.** `alert_delivery` is itself the durable observability record: every
  fire, suppression, and failure is a row, queryable per user and per subscription. `status =
  failed` rows are the alerting dashboard's backlog.

## 12. Performance & Scalability

- **Volumes (early).** Beachhead is the Turkish Aegean (D-007): thousands of users, tens of
  favorited/alerted spots, → low-thousands of subscriptions over low-hundreds of distinct spots. The
  15-min cron does one indexed `listEnabled` scan, groups in memory, and issues **one forecast read
  per distinct (spot, sport)** — bounded by the hot set, not by user count.
- **Hot path costs.** `listEnabled` uses `alert_subscription_enabled_spot_idx`. Forecast reads are
  ~75% cache hits (1h TTL vs 15-min cron). The dedup insert is a single-row upsert on the unique
  index. History reads are keyset-paginated on `alert_delivery_user_created_idx`.
- **The scaling lever is the spot fan-out, not the user fan-out.** Cost is `O(distinct spots ×
  sports)` provider calls + `O(subscriptions)` in-memory predicate checks — sharing forecasts across
  users is the whole point (same rationale as D-004/D-006 canonical-SI caching).
- **Deferred until it hurts (documented, not built):** (a) **bounded concurrency / sharding** the
  cron by spot region if a single 5-min run gets tight; (b) **change-gated evaluation** — skip
  spots whose cached forecast `modelRun` hasn't advanced since their last evaluation (a
  `lastEvaluatedModelRun` marker) to avoid re-scanning unchanged forecasts; (c) **bulk delivery
  insert** (multi-row `ON CONFLICT`) if per-match inserts dominate; (d) partitioning
  `alert_delivery` by month once history grows. None are needed at beachhead scale.

## 13. Testing Strategy

Co-located `*.service.spec.ts` next to each service; all dependencies mocked (repositories, ports,
infra). Deterministic `now` and canned `HourlySeries` fixtures drive the engine.

- **`alert-subscription.service.spec.ts`** — create/get/list/update/delete happy paths; ownership
  (foreign `uid` → `NOT_FOUND`); favorited+published assertion; unsupported sport → `FORM_ERROR`;
  `minWindMs > maxWindMs` → `FORM_ERROR`; bad timezone rejected; count cap → gate error; identical
  duplicate → `ALREADY_EXISTS` (409).
- **`alert-evaluation.service.spec.ts`** (the critical one):
  - **Matching:** a `go` run inside lead time fires; a `watch`/`skip` forecast never fires.
  - **Tighten-not-loosen:** a subscription `minWindMs` above the forecast suppresses an
    engine-`go` hour; a subscription can *never* turn an offshore/thunder `skip` into a match.
  - **Direction filter:** wind sector ∈/∉ `allowedDirections`.
  - **Confidence / window length / day-of-week / time-of-day** filters each gate correctly.
  - **Lead time:** a window beyond `leadTimeHours` (or in the past) does not fire.
  - **De-dup:** two runs over the same opportunity → one delivery (unique-conflict path); a window
    drifting 08:00→09:00 same local day → still one.
  - **Quiet hours:** a match inside the band → `suppressed`, then `sent` on the post-band run while
    the window is still future; a window that passes during quiet hours → abandoned.
  - **Per-user batching:** two matched spots for one user → one `enqueuePush`, two delivery rows.
  - **No target:** `hasDeliverableTarget=false` → `failed:no_target`, no push.
  - **Failure isolation:** one spot's forecast throwing does not abort the batch.
- **Merge:** `alertReassigner.reassignOwner` moves subscriptions + deliveries on the merge tx
  (exercised in the auth merge spec alongside favorites/activities).
- **Integration/manual before shipping:** run `alert-evaluate` against seeded subscriptions with a
  mocked Open-Meteo client end-to-end; verify one push per user and idempotency across a re-run.

## 14. Alternatives Considered

- **Real-time (event-driven) vs. batch cron.** Firing alerts the moment the weather cron refreshes a
  spot (weather → alerts event) would be lower-latency but couples the two domains, needs finer-grained
  dedup, and re-evaluates on every refresh even when nothing crossed a threshold. **Chosen: a 15-min
  batch** — bounded, simple, idempotent, and naturally aligned to model-refresh cadence. Latency of
  ≤15 min is immaterial for a "this weekend looks good" heads-up.
- **Per-user vs. per-spot fan-out.** Iterating users and fetching each user's spots would re-fetch
  and re-reason the same forecast once per follower of a popular spot (Alaçatı has many). **Chosen:
  per-spot fan-out** so one cached forecast serves every subscriber — the exact D-004 cache-sharing
  argument.
- **Dedup granularity: per-hour window vs. per-day opportunity.** An hour-keyed dedup would re-alert
  as `bestWindow` drifts hour-to-hour across runs (spam). **Chosen: per-day opportunity**
  (`sport:localDate`) — one "today/this day looks good" per subscription. An explicit *"it's good
  right now"* reminder is a separate future opportunity type, not a change to this dedup.
- **Baseline-plus-tighten vs. a fully custom rule engine.** Letting users author arbitrary rules
  (including looser than safe) would let someone silence offshore/thunder downgrades. **Chosen: the
  RFC-0005 engine `go` is the immutable baseline; subscriptions only narrow it** — safety stays
  centralized.
- **Precompute + store windows vs. recompute each run.** Persisting computed windows adds
  invalidation complexity for no gain — forecasts change between runs anyway and the computation is
  cheap. **Chosen: recompute from the cached forecast** (same call to `getEvaluableForecast`).
- **Quiet hours drop vs. defer.** Dropping is simpler but loses good days that surface overnight.
  **Chosen: defer** (hold the dedup claim, retry after the band) so nothing is missed.
- **Hot-set membership vs. warm-on-evaluation.** Feeding subscribed spots into the weather cron's
  hot-set query would create a spot↔alerts (feature↔feature) cycle and duplicate refresh work.
  **Chosen: evaluation reads through the cache-warming path**, so alerted spots stay warm for free —
  closing the RFC-0005 §6 "active alarms" note without new plumbing.

## 15. Implementation Plan (checklist)

Aligned with the "Adding a New Domain" checklist in [[../CLAUDE]] (bucket = `feature/`, default).

1. `src/db/schema.ts` — `confidenceEnum`, `alertDeliveryStatusEnum`, `alert_subscription` +
   `alert_delivery` tables + relations + indexes; add to `dbSchema`; export inferred types.
2. `src/db/index.ts` — re-export new types/enums as needed.
3. `npm run db:gen` → migration; notify team (don't auto-migrate prod).
4. `domains/feature/alerts/errors.ts` — `AlertReason as const` (`SPOT_NOT_FAVORITED`,
   `UNSUPPORTED_SPORT`, `INVALID_CRITERIA`, `ALERT_LIMIT_REACHED`, `DUPLICATE_SUBSCRIPTION`).
5. `.../schemas/index.ts` — Zod request + response (`.describe()` + `.meta({ ref })`).
6. `.../repositories/alert-subscription.repository.ts` + `.../repositories/alert-delivery.repository.ts`
   — `extends BaseRepository` (`listEnabled`, `countByUser`, `tryInsertDelivery` with `ON CONFLICT
   DO NOTHING`, `markSent/Suppressed/Failed`, keyset history, `reassignOwner`).
7. `.../services/alert-subscription.service.ts` (+ `.spec.ts`) — CRUD + invariants.
8. `.../services/alert-evaluation.service.ts` (+ `.spec.ts`) — the matching/dedup/quiet/batch engine.
9. `.../tasks/alert-evaluate.{schema,task,trigger}.ts` — the cron.
10. `.../routes/v1.ts` — `alertSubscriptionRoute` (each route `describeRoute` + `authenticate` +
    `zValidator` + handler → module service).
11. `.../alerts.module.ts` — `createAlertsModule(deps)` returning `{ alertSubscriptionService,
    alertEvaluationService, alertReassigner }`; wire ports (spot/weather/notification/tier) at the
    composition root; thread `alertReassigner` into `createAuthModule`.
12. RFC-0005 additive change: `WeatherService.getEvaluableForecast` implementing `AlertWeatherPort`.
13. `src/domains/index.ts` — `app.route("/v1/me/alerts", alertSubscriptionRoute)`.
14. `npm run lint:biome:fix && lint:type && lint:imports && test`; then the `convention-reviewer`
    agent, then `/review-principle` before a PR.

## 16. Open Questions & Resolved Decisions

- **Deferred build.** The whole domain is deferred behind RFC-0001 → RFC-0006 (Berkay, 2026-07-11 —
  alerts + monetization last; [[../otonom-kararlar]] §0, [[README]]). This RFC is the design to
  execute when the phase opens. ⏸️
- **Monetization boundary.** Free vs. pro alert count (proposal: free = 1 subscription, pro =
  unlimited) — needs Berkay + the RFC-0009 tier port. The `AlertTierPort` seam is built regardless. ❓
- **Timezone source.** Quiet hours / day filters need a zone. Proposal: add `timezone` to the
  RFC-0003 `user_profile` as the default, overridable per subscription; interim, store on the
  subscription and fall back to the spot's derived zone / UTC. ❓
- **`confidenceEnum` placement.** Promoting weather's inline confidence to a shared `pgEnum` here —
  confirm the enum lives in the weather section of `schema.ts` and both domains reuse it. ❓
- **Reminder variant.** MVP alerts are **lead-time heads-up only**; a separate "it's good right now"
  opportunity type (hour-keyed dedup, tighter cadence) is a possible follow-up, not in scope. ⏸️
- **Multi-sport per subscription.** Chosen: one subscription carries `sports[]` (per-sport dedup via
  `windowKey`), rather than a row per (spot, sport) — confirm this matches the app's alert UX. ✅
  (proposed)
- **Anonymous users.** Chosen: anonymous users *may* create alerts (they have a server user row);
  delivery still requires a registered token + consent, so anonymous-without-token subscriptions log
  `failed:no_target` until the user enables notifications. ✅ (proposed)

## 17. References

[[../SPLASH-OVERVIEW]] · [[0005-weather]] · [[0004-spot]] · [[0009-subscription-notification]] ·
[[weather-openmeteo-mapping]] · [[metrics-catalog]] B · [[decisions]] (D-004, D-006, D-007, D-008) ·
[[../otonom-kararlar]] (§0, §24, §27) · app `AlertModels.swift` · PRD §10.15
