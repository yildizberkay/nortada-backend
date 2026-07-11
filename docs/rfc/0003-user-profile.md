# RFC-0003: User Profile & Sport Preferences

|                |                                   |
| -------------- | --------------------------------- |
| **RFC**        | 0003                              |
| **Title**      | User Profile & Sport Preferences  |
| **Status**     | ✅ Completed                       |
| **Step**       | 2                                 |
| **Depends on** | RFC-0002                          |
| **Domain(s)**  | platform/user                     |
| **Updated**    | 2026-07-11                        |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected
> **Lifecycle:** set `🚧 In Progress` when implementation starts; `✅ Completed` when done. If a
> decision changes during implementation, update the RFC to match what was actually built.

---

## 1. Summary

This RFC delivers the user's app-wide personalization state — the backend home for what the
iOS app currently keeps in an in-memory `UserProfile`. It ships two tables in the
`platform/user` domain: **`user_profile`** (one global row per user — units, primary sport,
onboarding answers, the primary sport's summary-card metrics) and **`user_sport_profile`** (an
optional per-`(user, sport)` override row carrying that sport's card slots and an open `prefs`
tuning bag). Around them sit four `/v1/me/*` endpoints and a single `UserProfileService` that
ports the app's `SummaryMetric.defaultSlots(sport:goal:)` logic to the backend as the canonical
source of default card layouts.

The two design choices that matter most. **First**, the profile is *preferences only*: it stores
what unit a user *wants* to see, never converting stored values — canonical API values stay SI and
conversion is client-side (D-006). A GET on a user who has never onboarded returns a full set of
sensible defaults flagged **`onboarded: false`** (never a 404), so a consumer can tell "the user
deliberately chose windsurf + knots" from "these are guesses". **Second**, the primary sport's
card slots live in exactly one place — `user_profile.cardSlots` — and the per-sport read path
*overlays* them for the primary sport, so both ways of reading a sport's effective slots agree.
The partial-update PATCH runs inside a repository transaction with `SELECT … FOR UPDATE`, closing
a concurrent-PATCH lost-update window between two devices editing disjoint fields.

## 2. Motivation & Context

- **Problem.** The iOS app's `UserProfile` (`AnalyticsModels.swift`) is in-memory today —
  "persistence lands with the backend". Onboarding answers, unit preferences, the remembered
  Activity filter, and the per-sport summary-card layout all evaporate on reinstall and never sync
  across a user's devices. This RFC is the persistence layer for all of it, and the reference the
  activity data model already points at.
- **Background.** The split between *global* and *per-sport* state comes straight from the product:
  units and primary sport are a person-level choice, but the analytics layout, thresholds, and card
  slots are sport-specific (a user wants top speed for windsurf but average pace for SUP).
  [[activity-data-model]] §3 already references a `user_sport_profile`; this RFC defines it. Unit
  policy follows [[decisions]] D-006 (canonical SI on the wire, client converts). Auth (`c.var.user`,
  anonymous-or-Clerk) comes from RFC-0002.
- **Goals.**
  - Persist the global profile: one row per user, upsert-based, created lazily on first write.
  - Persist optional per-sport overrides with a forward-compatible `prefs` bag.
  - Port the app's `defaultSlots(sport, goal)` to the backend so default card layouts are computed
    server-side and stay identical across clients.
  - Make `GET /profile` answer for un-onboarded users with defaults + an explicit `onboarded` marker
    rather than an error.
  - Guarantee that two devices PATCHing disjoint fields can't silently revert each other.
  - Keep the primary sport's card slots single-sourced so `GET /profile` and `GET /sport-profiles`
    never disagree.
- **Non-goals.**
  - **Favorites** — needs a spot FK, so it ships with the spot domain in **RFC-0004**
    (`user_favorite`, unique `(userId, spotId)`).
  - **Sport-profile layout fields** (enabled sections / section order / timeline layers / default
    equipment) — the activity-dashboard vocabulary is defined in **RFC-0006**; those columns land
    there.
  - **Anonymous→Clerk merge of real data** (`reassignOwner`) — profile *preferences* are deliberately
    not carried on merge (D-008); the transactional reassign seam is built once transferable data
    (favorites) exists (RFC-0004).
  - **Clerk email/displayName hydration** — Clerk session tokens don't carry `email` by default;
    filling `user.email`/`displayName` from the Clerk User API is tracked separately
    ([[../otonom-kararlar]] §19), not part of the profile surface here.

## 3. Scope (In / Out)

- **In:** the `user_profile` (global) and `user_sport_profile` (per-sport override) tables + their
  enums; `UserProfileRepository` (incl. `upsertProfileWithLock`); `UserProfileService` (get/upsert
  profile, list/upsert sport profiles, default-slot derivation, effective-slot resolution); the four
  `/v1/me/*` routes; Zod request/response schemas (enum values derived from the Drizzle `pgEnum`s);
  the `user.module.ts` wiring; a co-located service spec.
- **Out:**
  - Favorites (table, service, routes) → **RFC-0004**.
  - Sport-profile *layout* fields → **RFC-0006** (activity dashboard).
  - Activity-level layout overrides (those live on `activity`, [[activity-data-model]] L3) →
    **RFC-0006**.
  - The merge/`reassignOwner` orchestration → built in **RFC-0004** when favorites become the first
    transferable data (D-008).

## 4. Domain Model & Ubiquitous Language

- **Global profile (`user_profile`).** Exactly one row per user, keyed by a unique `userId`. Holds
  person-level personalization: `primarySport`, the `sports[]` they do, `experience`, onboarding
  `goal`, analytics `focus`, the remembered `activityFilter` (null = "All Sports"), the primary
  sport's `cardSlots`, `defaultActivityPeriod`, and the three unit preferences
  (`windUnit`/`distanceUnit`/`temperatureUnit`). The row is created lazily — it does not exist until
  the first PATCH.
- **Per-sport profile (`user_sport_profile`).** An *optional* override row, one per `(user, sport)`.
  Present only when a user has customized a sport. Holds that sport's `cardSlots` (nullable → fall
  back to derived defaults) and an open `prefs` jsonb bag (per-sport tuning such as planing/foiling
  thresholds). A user can have zero of these.
- **Card slot (`SummaryMetric`).** One of the summary-card metrics a user pins to their dashboard
  (`distance`, `max_speed`, `best_5x10`, …). A layout is always exactly **four** slots.
- **Default slots.** The four slots a `(sport, goal)` combination opens with, computed by
  `defaultSlots(sport, goal)` — the canonical backend port of the app's
  `SummaryMetric.defaultSlots(sport:goal:)`.
- **Effective slots.** What a sport's card layout *actually* resolves to for reads, in priority order:
  the per-sport override's `cardSlots` → (for the primary sport) `user_profile.cardSlots` → the
  derived `defaultSlots`. This resolution is the single source of truth described in §7.
- **Onboarded marker.** A boolean on the *response* (not a stored column): `true` when a
  `user_profile` row exists, `false` when `GET` is answering with unpersisted defaults. It lets
  clients/insights distinguish a deliberate preference from a guess (D-006 unit prefs count as real
  only when `onboarded: true`). [[../otonom-kararlar]] §20.
- **Preferences, not values.** The profile never stores measured quantities. Units held here are
  display *preferences*; the API always returns canonical SI and the client converts (D-006).

## 5. Data Model (Drizzle)

Both tables live in `src/db/schema.ts` and are registered in `dbSchema` (`userProfile`,
`userSportProfile`). Enums are shared `pgEnum`s mirrored from the iOS vocabulary (lowercase
identifiers; display labels are client-side). Canonical SI units throughout (D-006); any stored
threshold is m/s.

### 5.1 Enums (`pgEnum`)

| Enum                  | Values                                                                                             | Notes |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----- |
| `sport`               | `windsurf, wingfoil, sailing, kitesurf, sup, kayak, other`                                          | Cross-cutting; reused by activity/spot/alerts. |
| `experience_level`    | `beginner, intermediate, advanced, racing`                                                          | |
| `main_goal`           | `find_days, track_sessions, improve_speed, improve_technique, consistency, racing, explore`         | Drives default slots. |
| `analytics_focus`     | `balanced, speed, endurance, technique, racing, custom`                                             | |
| `wind_unit`           | `kt, ms, kmh, mph`                                                                                   | Preference only. |
| `distance_unit`       | `km, mi, nm`                                                                                         | Preference only. |
| `temperature_unit`    | `c, f`                                                                                               | Preference only. |
| `summary_metric`      | `distance, time_on_water, moving_time, max_speed, avg_speed, best_10s, best_5x10, avg_pace, best_vmg, sessions, active_days` | The card-slot vocabulary. |
| `activity_period`     | `week, month, season, year, custom`                                                                 | Default Activity window. |

### 5.2 `user_profile` — global, one row per user

Purpose: person-level personalization. Every table carries the shared `id` (internal integer
identity PK, never exposed) + `uid` (public opaque UUID) + `createdAt`/`updatedAt` from RFC-0001's
column helpers.

| Column                  | Type                          | Rationale (non-obvious) |
| ----------------------- | ----------------------------- | ----------------------- |
| `userId`                | `integer` **unique** FK→`user.id` | The uniqueness constraint is what makes this a *single global profile*. It is also the `onConflict` target for the upsert. |
| `primarySport`          | `sport` NOT NULL              | Drives which sport's slots `user_profile.cardSlots` represents. |
| `sports`                | `sport[]` NOT NULL            | Every sport the user does (superset of `primarySport`). |
| `experience`            | `experience_level` NOT NULL   | Onboarding answer. |
| `goal`                  | `main_goal` NOT NULL          | Onboarding answer; a change re-derives default card slots (§7). |
| `focus`                 | `analytics_focus` NOT NULL    | Onboarding answer. |
| `activityFilter`        | `sport` (nullable)            | Remembered Activity list filter. **`null` = "All Sports"** — a meaningful value, so PATCH treats explicit `null` distinctly from "omitted" (§7). |
| `cardSlots`             | `summary_metric[]` NOT NULL   | The **primary sport's** four summary-card metrics — mirrors the app's `UserProfile.cardSlots`. Single source of truth for the primary sport (per-sport overrides live in `user_sport_profile`). |
| `defaultActivityPeriod` | `activity_period` NOT NULL    | Default period for the Activity screen. |
| `windUnit`              | `wind_unit` NOT NULL          | Display preference only (D-006). |
| `distanceUnit`          | `distance_unit` NOT NULL      | Display preference only (D-006). |
| `temperatureUnit`       | `temperature_unit` NOT NULL   | Display preference only (D-006). |

No index beyond the unique `userId` (all reads are `WHERE userId = ?`, a unique lookup).

### 5.3 `user_sport_profile` — per-sport override

Purpose: optional per-`(user, sport)` customization. Rows exist only when a user tunes a sport.

| Column      | Type                        | Rationale (non-obvious) |
| ----------- | --------------------------- | ----------------------- |
| `userId`    | `integer` FK→`user.id`      | Owner. |
| `sport`     | `sport` NOT NULL            | Which sport this overrides. |
| `cardSlots` | `summary_metric[]` (nullable) | **`null` → fall back to the derived defaults** for this sport (or, for the primary sport, to `user_profile.cardSlots`). |
| `prefs`     | `jsonb().$type<JsonValue>()` (nullable) | Open per-sport tuning bag. Holds e.g. `planingThresholdMps` / `foilingThresholdMps` in canonical SI m/s. See §5.4 for why these are jsonb, not columns. Layout fields (enabled sections / timeline layers) are added here in RFC-0006. |

- **Unique index** `user_sport_profile_user_sport_key` on `(userId, sport)` — one override per sport,
  and the `onConflict` target for the full-replace upsert (§7).

### 5.4 Thresholds live in `prefs`, not dedicated columns

An earlier draft had dedicated `planingThresholdMps` / `foilingThresholdMps` `real` columns. They
were removed and folded into `prefs` ([[../otonom-kararlar]] §28.2, Berkay's refinement): these
thresholds are meaningful only for *some* sports (windsurf/wing plane and foil; SUP/kayak never do),
so sparse dedicated columns would be mostly-null. A flexible jsonb bag is the better fit and keeps
the table forward-compatible for future per-sport keys without a migration each time. The `Mps`
suffix is deliberate — an earlier `…Ms` read as *milliseconds*; these are **m/s speeds** (D-006
unit clarity, [[../otonom-kararlar]] §21c).

### 5.5 Migration

Both tables and their enums are in the consolidated `0000` migration (`npm run db:gen`). Because the
DB was never applied during the autonomous build, per-RFC migrations were squashed into a single
clean `0000` rather than a rename/drop trail ([[../otonom-kararlar]] §0, §28). Per-RFC schema
evolution is preserved in the `schema.ts` git history.

## 6. API Surface (routes + OpenAPI)

All routes are user-scoped and mounted under `/v1/me` (`app.route("/v1/me", userRoute)`), with
`userRoute.use("*", authenticate)` applying the dual-source auth middleware to every handler.

| Method | Path                          | Auth                | Summary                                        |
| ------ | ----------------------------- | ------------------- | ---------------------------------------------- |
| GET    | `/v1/me/profile`              | anon JWT **or** Clerk | Get the global profile (defaults if none)      |
| PATCH  | `/v1/me/profile`              | anon JWT **or** Clerk | Partial update / lazy-create of the profile    |
| GET    | `/v1/me/sport-profiles`       | anon JWT **or** Clerk | List per-sport overrides (with effective slots) |
| PUT    | `/v1/me/sport-profiles/:sport`| anon JWT **or** Clerk | Full-replace a per-sport override               |

**Envelopes** follow RFC-0001: success → `{ data }` via `HTTPResponse.success(...)`; errors →
`{ error, reason?, message, statusCode }` from the central error-handler middleware. **Errors** are
uniform across the surface: `401 UNAUTHENTICATED` if the token is missing/invalid (from
`authenticate`), and `422 FORM_ERROR` for a Zod validation failure (from `zValidator`). This RFC
defines **no domain-specific error reasons** — `UserReason = {}` — because every endpoint is
upsert-based and GET returns defaults rather than 404ing (§16).

### 6.1 `GET /v1/me/profile` — `getMyProfile`

- **Auth:** anonymous JWT or Clerk (`c.var.user`).
- **Request:** none.
- **Response:** `200` `{ data: UserProfileResponse }`. Always returns a full profile: the persisted
  row flagged `onboarded: true`, or the unpersisted defaults flagged `onboarded: false`. Never 404s.
- **Errors:** `401 UNAUTHENTICATED`.
- **Example (un-onboarded user):**

  ```jsonc
  // → 200
  {
    "data": {
      "onboarded": false,
      "primarySport": "windsurf",
      "sports": ["windsurf"],
      "experience": "intermediate",
      "goal": "improve_speed",
      "focus": "speed",
      "activityFilter": null,
      "cardSlots": ["distance", "time_on_water", "best_5x10", "sessions"],
      "defaultActivityPeriod": "week",
      "windUnit": "kt",
      "distanceUnit": "km",
      "temperatureUnit": "c"
    }
  }
  ```

### 6.2 `PATCH /v1/me/profile` — `updateMyProfile`

- **Auth:** anonymous JWT or Clerk.
- **Request:** `updateProfileSchema` — every field optional (`.partial()`), so onboarding sends the
  full set on the first call and later edits send only what changed. Validation: `sports` min length
  1; `cardSlots` **exactly length 4**; `activityFilter` nullable; all enum fields constrained to the
  `pgEnum` values.
- **Response:** `200` `{ data: UserProfileResponse }` with `onboarded: true` (a successful PATCH
  means a row now exists).
- **Behavior:** partial upsert — lazily creates the row on first PATCH, otherwise merges the supplied
  fields over the existing row (see §7 for the merge, default-slot re-derivation, and the row lock).
- **Errors:** `401 UNAUTHENTICATED`, `422 FORM_ERROR`.
- **Example (change goal only, slots not pinned):**

  ```jsonc
  // PATCH body
  { "goal": "improve_technique" }
  // → 200
  {
    "data": {
      "onboarded": true,
      "goal": "improve_technique",
      "cardSlots": ["time_on_water", "moving_time", "best_5x10", "sessions"],
      /* …all other fields carried over from the existing row… */
    }
  }
  ```

### 6.3 `GET /v1/me/sport-profiles` — `listMySportProfiles`

- **Auth:** anonymous JWT or Clerk.
- **Request:** none.
- **Response:** `200` `{ data: { sportProfiles: SportProfileResponse[] } }`. Each entry has its
  **effective** card slots resolved (§7), so a `null` stored `cardSlots` is returned filled-in, and
  the primary sport reflects `user_profile.cardSlots`. Returns `[]` when the user has no overrides.
- **Errors:** `401 UNAUTHENTICATED`.
- **Example:**

  ```jsonc
  // → 200
  {
    "data": {
      "sportProfiles": [
        {
          "sport": "sup",
          "cardSlots": ["distance", "moving_time", "avg_pace", "sessions"],
          "prefs": null
        }
      ]
    }
  }
  ```

### 6.4 `PUT /v1/me/sport-profiles/:sport` — `upsertMySportProfile`

- **Auth:** anonymous JWT or Clerk.
- **Request:** path param `sport` (validated against the `sport` enum via `sportParamSchema`); body
  `upsertSportProfileSchema` = `{ cardSlots?: SummaryMetric[4] | null, prefs?: Record<string, unknown> | null }`.
- **Response:** `200` `{ data: SportProfileResponse }` — the upserted override with its **effective**
  slots resolved.
- **Behavior:** **full replacement (PUT semantics).** The client sends the complete representation of
  the override; any field it omits is cleared to `null`. Because it is a full replace there is no
  read-modify-write and thus no lost-update window (contrast the PATCH in §7). Idempotent.
- **Errors:** `401 UNAUTHENTICATED`, `422 FORM_ERROR`.
- **Example (set foiling threshold, clear card override):**

  ```jsonc
  // PUT /v1/me/sport-profiles/wingfoil  body
  { "prefs": { "planingThresholdMps": 6.5, "foilingThresholdMps": 8 } }
  // → 200 — cardSlots omitted ⇒ cleared to null ⇒ resolves to derived defaults
  {
    "data": {
      "sport": "wingfoil",
      "cardSlots": ["distance", "time_on_water", "best_10s", "sessions"],
      "prefs": { "planingThresholdMps": 6.5, "foilingThresholdMps": 8 }
    }
  }
  ```

### 6.5 Zod schemas derived from `pgEnum.enumValues`

Request and response schemas reuse the Drizzle enum values directly — `z.enum(sportEnum.enumValues)`,
`z.enum(summaryMetricEnum.enumValues)`, etc. The DB enum is the single source of truth for the
vocabulary; the schema layer imports the *values* (never DB operators, which stay in repositories).
Response schemas carry `.describe()` + `.meta({ ref })`: `UserProfileResponse`, `SportProfileResponse`,
`SportProfileListResponse`.

## 7. Services & Business Logic

All logic lives in `UserProfileService extends BaseUseCase` (no DB handle; it calls
`UserProfileRepository`). Signatures:

```typescript
getProfile(user: RequestUser): Promise<ProfileResponse>
updateProfile(user: RequestUser, input: UpdateProfileInput): Promise<ProfileResponse>
getSportProfiles(user: RequestUser): Promise<SportProfileResponse[]>
upsertSportProfile(user: RequestUser, sport: Sport, input: UpsertSportProfileInput): Promise<SportProfileResponse>
```

### 7.1 Default card slots — the ported app algorithm

`defaultSlots(sport, goal)` is the canonical backend port of the iOS
`SummaryMetric.defaultSlots(sport:goal:)`. It returns the four opening card metrics for a
`(sport, goal)` pair:

| Sport                | Goal                          | Default slots |
| -------------------- | ----------------------------- | ------------- |
| windsurf             | `improve_speed` / `racing`    | `distance, time_on_water, best_5x10, sessions` |
| windsurf             | `improve_technique`           | `time_on_water, moving_time, best_5x10, sessions` |
| windsurf             | (other)                       | `distance, time_on_water, max_speed, sessions` |
| wingfoil / kitesurf  | any                           | `distance, time_on_water, best_10s, sessions` |
| sailing              | any                           | `distance, time_on_water, avg_speed, sessions` |
| sup / kayak          | any                           | `distance, moving_time, avg_pace, sessions` |
| other (default)      | any                           | `distance, time_on_water, max_speed, sessions` |

`defaultValues()` composes the un-onboarded starting profile (primary sport `windsurf`, goal
`improve_speed`, `intermediate`, focus `speed`, `activityFilter: null`, period `week`, units
`kt`/`km`/`c`, and `cardSlots = defaultSlots("windsurf", "improve_speed")`).

### 7.2 `getProfile` — defaults with an onboarding marker

Reads `findByUserId`. If a row exists → `{ onboarded: true, ...profileValues(row) }`. If not →
`{ onboarded: false, ...defaultValues() }`. **The defaults are not persisted** — GET is a pure read.
This is the [[../otonom-kararlar]] §20 decision: rather than 404 on a missing profile (the old
`PROFILE_NOT_FOUND` branch, now removed), the endpoint hands back a usable profile and lets the
client distinguish deliberate choices (`onboarded: true`) from guesses (`onboarded: false`).

### 7.3 `updateProfile` — merge, re-derive slots, under a row lock

`updateProfile` delegates to `repository.upsertProfileWithLock(userId, compute)`, passing a `compute`
callback that receives the current row (or `undefined`) and returns the full new value set. The
merge rules inside `compute`:

- **Base** = `profileValues(existing)` if a row exists, else `defaultValues()`.
- Each field = `input.<field> ?? base.<field>` (supplied wins, omitted is carried over).
- **`activityFilter`** is special-cased with `input.activityFilter !== undefined ? input.activityFilter
  : base.activityFilter`, because **`null` is a meaningful value ("All Sports")** and must be
  distinguishable from "omitted". A plain `??` would wrongly treat an explicit `null` as "not
  supplied".
- **Card-slot re-derivation.** `cardSlots = input.cardSlots ?? base.cardSlots`, but if the client did
  *not* pin `cardSlots` **and** (it's a first create **or** `primarySport` changed **or** `goal`
  changed) → `cardSlots = defaultSlots(primarySport, goal)`. This mirrors the app's
  `applyGoalDefaults`: changing sport/goal refreshes the layout unless the user has explicitly pinned
  their own slots.

The callback's result is written by the repository (§7.5) and the service returns
`{ onboarded: true, ...profileValues(saved) }`.

### 7.4 Effective card slots — one source of truth

Both `getSportProfiles` and `upsertSportProfile` resolve *effective* slots through
`toSportProfileResponse(row, ctx)`, where `ctx: SlotContext` is built once by `slotContext(user)`
(reading the global profile, or defaults, for `goal`, `primarySport`, and `primaryCardSlots`). The
resolution:

```
effectiveCardSlots =
  row.cardSlots                                   // explicit per-sport override
  ?? (row.sport === ctx.primarySport
        ? ctx.primaryCardSlots                     // primary sport → user_profile.cardSlots
        : defaultSlots(row.sport, ctx.goal))       // else derived defaults
```

The middle branch is the fix for the double-source hazard ([[../otonom-kararlar]] §21a): the primary
sport's slots exist on `user_profile.cardSlots`. If a `user_sport_profile` row for the primary sport
has `cardSlots: null`, we must **overlay the global profile's slots**, not re-derive defaults —
otherwise `GET /profile` (which reads `user_profile.cardSlots`) and `GET /sport-profiles` (which
reads the override) could disagree for the same sport. Overlaying guarantees both read paths return
the same thing.

### 7.5 Repository — the lost-update fix

`UserProfileRepository extends BaseRepository` owns all DB access. Reads use `db.query.*.findFirst/
findMany` with explicit `columns` allow-lists. Two upsert methods, deliberately different:

- **`upsertProfileWithLock(userId, compute)` (PATCH path).** Read-modify-write, so it runs inside
  `dbClient.transaction`:

  ```typescript
  return this.dbClient.transaction(async (tx) => {
    const [existing] = await tx
      .select().from(userProfileTable)
      .where(eq(userProfileTable.userId, userId))
      .for("update")               // ← SELECT … FOR UPDATE: row lock
      .limit(1);
    const values = compute(existing);
    const [row] = await tx
      .insert(userProfileTable)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: userProfileTable.userId, set: { ...values, updatedAt: new Date() } })
      .returning();
    return row;
  });
  ```

  The `SELECT … FOR UPDATE` locks the profile row for the duration of the transaction, so two devices
  PATCHing **disjoint** fields concurrently are serialized: device B reads the row *after* device A's
  write commits, merges onto the fresh state, and no field is silently reverted. Without the lock, B's
  read-modify-write could interleave with A's and overwrite A's change with a stale base — a classic
  lost update ([[../otonom-kararlar]] §21b). The `onConflictDoUpdate` on the unique `userId` also
  makes the first-create case a clean insert without a separate existence check.

- **`upsertSportProfile(userId, sport, values)` (PUT path).** A plain `insert … onConflictDoUpdate`
  on the `(userId, sport)` unique index — **no transaction, no lock.** Because PUT is a full replace,
  the caller supplies the complete representation; there is no read-modify-write, so there is no
  lost-update window to close. Last write wins, which is correct for full-replace semantics.

### 7.6 Cross-domain seams (deferred)

The `FavoriteService` and the merge `reassignOwner` hook are *not* in this RFC. Per **D-008**, an
anonymous→Clerk merge does **not** carry profile *preferences*: branch-1 (upgrade-in-place, same
`user.id`) keeps everything by construction; branch-2 (target already has a Clerk profile) lets the
target's profile win and leaves the anonymous `user_profile` row as harmless dead data (never
queried — auth always resolves to the live user; `userId` is unique). The transactional
`reassignOwner` seam is built in RFC-0004 when favorites become the first *real* transferable data.

## 8. Background Jobs (Trigger.dev)

N/A. Profile state is entirely request-driven; there are no crons or tasks.

## 9. Dependencies & Integrations

- **RFC-0002 (auth).** Provides `authenticate` (dual-source anonymous-JWT / Clerk middleware) and the
  `RequestUser` shape (`id`, `uid`, `isAnonymous`, `clerkUserId`, `isAdmin`) via `c.var.user`. Every
  route here is user-scoped through it.
- **RFC-0001 (foundation).** `BaseUseCase` / `BaseRepository`, the module/`buildContainer` DI, the
  `HTTPResponse` envelopes, the shared column helpers and `dbSchema`, and `hono-openapi`.
- **No external services.** No Clerk User API call, no Open-Meteo, no S3. (Clerk email/displayName
  hydration is tracked separately — [[../otonom-kararlar]] §19.)
- **Seams exposed downstream.** The `sport` enum and the `user_profile`/`user_sport_profile` tables
  are consumed by RFC-0006 (activity dashboard adds layout fields to `user_sport_profile`) and the
  merge reassign seam introduced in RFC-0004 references this domain's ownership model.

## 10. Security & Privacy

- **Ownership.** Every query is scoped to `c.var.user.id`; there is no way to read or write another
  user's profile — no user id is accepted from the client, only from the authenticated context.
- **Anonymous users have profiles too.** An anonymous JWT user can create and edit a profile. On
  branch-1 login it is preserved; on branch-2 it is superseded (D-008). No endpoint requires a real
  Clerk identity.
- **PII.** Minimal. `email`/`displayName` are Clerk's system of record and are **not** stored on the
  profile. The profile holds only personalization state (sports, units, layout).
- **Input hardening.** All bodies pass Zod validation before reaching the service — enum fields are
  constrained to the `pgEnum` values, `cardSlots` is fixed at length 4, `sports` is non-empty. DB
  access is confined to the repository (type-level + the `lint:imports` grep guard).

## 11. Observability

No bespoke logging in this domain — the standard request path and the central error-handler apply.
Validation failures surface as `422 FORM_ERROR` and auth failures as `401 UNAUTHENTICATED`, both
returned to the client without being reported as exceptions (they are expected `GenericError`s, per
RFC-0001 §11). There are no `INTERNAL_ERROR`/`EXTERNAL_SERVICE_ERROR` paths unique to this RFC.

## 12. Performance & Scalability

- **Volumes.** One `user_profile` row per user; at most a handful of `user_sport_profile` rows per
  user (bounded by the sport enum, 7). Tiny.
- **Hot paths.** All reads are single-row (or small) unique-index lookups on `userId`
  (`user_profile_user_id_key`) and `(userId, sport)` (`user_sport_profile_user_sport_key`) — sub-ms.
- **The PATCH transaction** holds a row lock only for the duration of one profile's read-merge-write;
  contention is inherently per-user (two of a single user's devices), never cross-user, so the lock
  never becomes a global bottleneck.
- **Payloads.** Responses are a few hundred bytes; `prefs` is a small bag. No pagination needed — a
  user's sport-profile list is at most 7 entries.

## 13. Testing Strategy

`user-profile.service.spec.ts` is co-located and mocks the repository entirely (`BaseUseCase` has no
DB). It drives `upsertProfileWithLock` by running the service's `compute` callback against a supplied
"existing" row and echoing the computed values back as a persisted row. Covered scenarios:

- **`getProfile`** — returns unpersisted defaults flagged `onboarded: false`; returns a persisted row
  flagged `onboarded: true`.
- **`updateProfile`** — derives default slots for a fresh profile by sport; re-derives default slots
  when `goal` changes and none are pinned; **respects explicitly-pinned** `cardSlots`; persists an
  explicit `null` `activityFilter` (the "All Sports" edge — proving `null` ≠ omitted).
- **Sport profiles** — derives effective slots for a non-primary sport override; **uses the profile's
  slots for the primary sport** (the single-source-of-truth overlay, §7.4); full-replaces an override
  and **clears omitted fields to `null`** (PUT semantics, with a threshold now living in `prefs`).

The concurrent-PATCH lock is a repository/transaction concern; the service test asserts the
merge/derivation logic, and the lock behavior is documented as the reason `updateProfile` routes
through `upsertProfileWithLock` rather than a plain upsert (no live-DB integration test exists yet —
the DB was never applied during the autonomous build, [[../otonom-kararlar]] §0).

## 14. Alternatives Considered

- **404 on a missing profile (the old `PROFILE_NOT_FOUND` branch).** Rejected in favor of returning
  defaults + `onboarded: false`. A 404 forced every client to special-case "no profile yet" and lost
  the deliberate-vs-guessed distinction that D-006 needs (unit prefs count as real only when
  onboarded). [[../otonom-kararlar]] §20.
- **Plain PATCH upsert without a row lock.** Rejected — two devices PATCHing disjoint fields could
  interleave read-modify-write and silently revert each other (lost update). The fix is
  `SELECT … FOR UPDATE` inside `dbClient.transaction`, serializing concurrent edits of the same
  profile. PUT on sport profiles keeps *no* lock, deliberately, because a full replace has no
  read-modify-write window. [[../otonom-kararlar]] §21b.
- **Storing the primary sport's slots in both `user_profile` and a `user_sport_profile` row for the
  primary sport.** Rejected — double-sourcing invites the two read paths to disagree. The primary
  sport's slots live *only* in `user_profile.cardSlots`, and the per-sport resolver overlays them for
  the primary sport. [[../otonom-kararlar]] §21a.
- **Dedicated `planingThresholdMps` / `foilingThresholdMps` columns.** Rejected — these are meaningful
  only for windsurf/wing, so dedicated columns would be mostly null across sports. Moved into the
  `prefs` jsonb bag: sparse, forward-compatible, no migration per new per-sport key. The `Mps` naming
  fixes an earlier `Ms` that read as milliseconds. [[../otonom-kararlar]] §28.2, §21c.
- **A separate onboarding domain/table/service.** Rejected as overkill — `updateProfile`'s upsert
  creates the first profile, and GET's `onboarded` flag communicates onboarding state. No extra table
  or service needed.
- **Carrying profile preferences on anonymous→Clerk merge.** Rejected (D-008) — a user with an account
  on another device should inherit *that account's* preferences; profile prefs are device-local
  personalization. Only real data (favorites, activities) is worth a transactional reassign, built
  when that data exists.

## 15. Implementation Plan (checklist)

1. **Schema** — `user_profile` + `user_sport_profile` tables + the profile enums in
   `src/db/schema.ts`; register in `dbSchema`; export `$inferSelect`/`$inferInsert` types. ✅
2. `npm run db:gen` — folded into the consolidated `0000` migration ([[../otonom-kararlar]] §28). ✅
3. **`user/errors.ts`** — `UserReason = {}` (no domain errors yet). ✅
4. **`schemas/index.ts`** — request (`updateProfileSchema` partial, `sportParamSchema`,
   `upsertSportProfileSchema`) + response (`profileResponseSchema`, `sportProfileResponseSchema`,
   `sportProfileListResponseSchema`) with `.describe()`+`.meta({ref})`, enums from
   `pgEnum.enumValues`. ✅
5. **`repositories/user-profile.repository.ts`** — `findByUserId`, `upsertProfileWithLock`
   (transaction + `FOR UPDATE`), `listSportProfilesByUserId`, `findSportProfile`, `upsertSportProfile`. ✅
6. **`services/user-profile.service.ts`** — `defaultSlots`, `defaultValues`, `getProfile`,
   `updateProfile`, `getSportProfiles`, `upsertSportProfile`, effective-slot resolution. ✅
7. **`services/user-profile.service.spec.ts`** — co-located unit test (§13). ✅
8. **`routes/v1.ts`** — four routes with `describeRoute` + `authenticate` + `zValidator` → module
   service. ✅
9. **`user.module.ts`** — `createUserModule({ db })` returning `{ userProfileService }`; wired in
   `src/container.ts`; `app.route("/v1/me", userRoute)` in `src/domains/index.ts`. ✅
10. `npm run lint:biome:fix && lint:type && lint:imports && test`. ✅

*(Favorites, sport-profile layout fields, and the merge reassign seam are intentionally deferred —
§3 Out.)*

## 16. Open Questions & Resolved Decisions

- ~~404 on missing profile vs defaults~~ → **defaults + `onboarded` marker**; no separate onboarding
  domain ([[../otonom-kararlar]] §20). ✅
- ~~Concurrent-PATCH lost update~~ → **`SELECT … FOR UPDATE` in a transaction** on the PATCH path;
  PUT sport-profile stays lock-free (full replace) ([[../otonom-kararlar]] §21b). ✅
- ~~Primary sport card-slot double source~~ → **single source in `user_profile.cardSlots`**, overlaid
  by the per-sport resolver ([[../otonom-kararlar]] §21a). ✅
- ~~Threshold columns vs jsonb~~ → **`prefs` jsonb bag** (`planingThresholdMps`/`foilingThresholdMps`,
  canonical m/s) ([[../otonom-kararlar]] §28.2, §21c). ✅
- ~~Merge reassign & favorites~~ → deferred to **RFC-0004+**; profile prefs not carried on merge
  ([[../otonom-kararlar]] §18, [[decisions]] D-008). ✅
- **Clerk email/displayName hydration** — session tokens don't carry `email`; filling these from the
  Clerk User API is tracked as its own follow-up, out of scope here ([[../otonom-kararlar]] §19). ⏸️

## 17. References

[[activity-data-model]] §3 · app `AnalyticsModels.swift` (`UserProfile` / `SummaryMetric`) ·
[[decisions]] D-006, D-008 · [[../otonom-kararlar]] §18, §19, §20, §21, §28 ·
[[architecture]] · [[0001-foundation]] · [[0002-auth]]
