# RFC-0006: Activity / Session (Upload, Storage & Canonical Metrics)

|                |                                                        |
| -------------- | ------------------------------------------------------ |
| **RFC**        | 0006                                                   |
| **Title**      | Activity / Session (Upload, Storage & Canonical Metrics) |
| **Status**     | ✅ Completed (P0)                                       |
| **Step**       | 5                                                      |
| **Depends on** | RFC-0002 (identity/auth), RFC-0004 (spot), RFC-0005 (weather) |
| **Domain(s)**  | feature/activity                                       |
| **Updated**    | 2026-07-11                                             |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected
> **Lifecycle:** set `🚧 In Progress` when implementation starts; `✅ Completed` when done. If a
> decision changes during implementation, update the RFC to match what was actually built.

---

## 1. Summary

This RFC delivers the **activity (session) domain**: a rider finishes a watersports session on
the water, the iOS app uploads the raw GPS track once (gzipped, over a single request), and the
backend becomes the **canonical, authoritative source** of every derived metric — distance,
filtered max/avg speed, moving time, best time/distance efforts, the 5×10 record, and the map
route polyline. The device shows fast, approximate numbers live; the backend recomputes the
"one true" values from the immutable track in a background job (D-001).

The single most important design choice is the **4-layer storage model** ([[activity-data-model]]):
the raw track (**L0**) is written **once and never mutated**, and all derived analysis (**L1**)
is a pure, versioned function of it (`algorithm_version` + `input_data_version`). This makes the
whole metric surface **recomputable** — when the algorithm improves we re-run it over stored
tracks without asking the app to re-upload anything. The raw track itself is too large for
Postgres, so it lives in **S3 object storage** (gzipped JSON) behind an `ObjectStorage` port,
and the `activity_track` row keeps only a `storage_key` + `sample_count` pointer
([[../otonom-kararlar]] §30). Upload is **idempotent** on a client-generated `uid`, hardened
against decompression-bomb DoS, and durable against a stranded `processing` state.

## 2. Motivation & Context

- **Problem.** The iOS app's tracking is currently fully **simulated**: there is no real GPS
  capture, and the "peak splits" are fake (derived as `maxSpeed × coefficient`). Real
  speedsurfing/watersports value comes from a track a rider trusts — a filtered max speed that
  isn't a GPS spike, a best 5×10 that matches dedicated Doppler loggers within ~0.1 kt, a map
  hero of where they actually sailed. None of that exists without a backend that stores the
  raw track and computes canonical metrics from it.
- **Background.** The full product spec, condensed and phased for the backend, is
  [[activity-data-model]] (the 4-layer model + shared primitives). The GPS transport / sizing
  research is [[research/gps-tracking]] (≈1 Hz iPhone GPS, ~0.2–1.2 MB raw / ~50–250 KB
  gzipped per 1–2 h session — "size is not a problem", single request, no chunking). The metric
  catalog is [[metrics-catalog]] family A. The governing decisions are [[decisions]] D-001
  (canonical metrics computed backend-side from the raw track), D-006 (canonical SI units,
  client converts), and D-008 (anonymous→Clerk merge moves real data in one transaction).
- **Goals.**
  - Ingest a full session in **one gzipped request**, store the raw track immutably, and
    return quickly (metrics computed asynchronously).
  - Be the **canonical** speed/distance authority: a pure, unit-tested metric engine that is
    independent of DB/HTTP and re-runnable as it improves.
  - Never lose a track and never strand one: **idempotent** upload, **transactional** L0 ingest,
    and a **status-keyed** enqueue that recovers a session whose compute never fired.
  - Be **Apple-Watch-ready from P0**: `source` (`iphone|watch|import|manual`) is in the schema
    now even though watch data lands later.
  - Give the rider L3 context (notes, feeling, tags, perceived effort, privacy) and a reusable
    equipment library snapshotted onto each session.
- **Non-goals (deferred to later phases, not "elsewhere in P0").**
  - Fine-grained P1 analysis: `activity_maneuver` (tack/gybe detail), `activity_interval`
    (planing/foiling/port-starboard), `alpha` efforts, `activity_timeline` (+ charts),
    forecast-vs-reality, and the `activity_correction` (L2) mechanism.
  - P2+: wind-relative metrics (VMG/TWA/polar), sailing point-of-sail + legs, SUP/kayak
    splits+stroke, kite transitions, and **HealthKit/HR** (the Apple Watch phase — schema is
    ready, data comes later).
  - Enforcing privacy on shared routes (there is no public sharing surface in P0 — see §10/§16).

## 3. Scope (In / Out)

- **In (P0):** the `feature/activity` domain — eight tables (`activity`, `activity_track`,
  `activity_condition`, `activity_summary`, `activity_route`, `activity_effort`,
  `equipment_profile`, `activity_equipment`); the gzip **upload** endpoint (idempotent,
  DoS-hardened); list / detail / patch-context / delete; the **equipment** library
  (list + create); the **pure canonical metric engine** (`metrics.ts`); the
  `activity-compute-metrics` **Trigger task**; the `ObjectStorage` port + `S3ObjectStorage`
  adapter (raw track → S3, gzipped JSON); and the D-008 merge reassigner for activities +
  equipment. Sports: **windsurf, wingfoil, sailing, other** (the `sport` enum is broader).
- **Out:** all P1+ items in §2 non-goals. Cross-session **records/insights** aggregation
  reads `activity_effort` / `activity_summary` but is **RFC-0007**'s job. Real object-storage
  integration testing (no bucket/creds in this environment — §13).

## 4. Domain Model & Ubiquitous Language

- **Activity (a.k.a. Session).** One watersports outing. The immutable **L0 identity** row
  (`activity`) plus its status, provenance, coarse geo, and inline **L3 context**. Public id is
  `uid` (a client-generated UUIDv4). State machine (`activity_status`):
  `processing` → `ready` | `failed`.
  - `processing`: uploaded, metrics not yet computed.
  - `ready`: canonical L1 metrics stored.
  - `failed`: the compute task threw (raw track is still safe; a recompute can retry).
- **Track (L0).** The immutable, high-resolution GPS `Sample[]`. Physically in S3 (gzipped
  JSON); the `activity_track` row is only a `storage_key` + `sample_count` pointer.
- **Sample.** One GPS fix: `{ t, lat, lon, speed?, hAccuracy?, sAccuracy? }` in canonical SI.
  `speed` is the device **Doppler** ground speed (chip-measured, more accurate than
  position-derived); `hAccuracy` is horizontal accuracy (m); `sAccuracy` is CoreLocation
  `speedAccuracy` (m/s; `< 0` ⇒ the Doppler speed is invalid).
- **Condition (L0).** A weather snapshot at record time, one row per `kind`
  (`forecast` | `observed`) so forecast-vs-reality is possible later. P0 stores only the
  `forecast` the app already showed the rider.
- **Summary / Route / Effort (L1, derived, versioned).** The recomputable analysis: the core
  `activity_summary`, the render-friendly `activity_route` (encoded polyline), and one
  `activity_effort` row per best-effort record. Every L1 row carries analysis metadata
  (`algorithm_version`, `computed_at`; summary also `input_data_version`).
- **Effort.** A best-effort record over a window: a **time** window (2s…5m), a **distance**
  window (100m…1 NM), or the **5×10** rule. `resultMs` is the average speed (m/s) over the
  window.
- **Equipment profile.** A reusable, per-user gear item (`board|sail|wing|kite|foil|boat|sup|
  kayak|paddle|generic`) with a jsonb `attributes` bag. Linked to a session via
  `activity_equipment`, which **snapshots** the profile's values at record time so editing the
  profile later never rewrites past sessions.
- **Canonical metric engine.** The pure `computeMetrics(rawSamples)` in `metrics.ts` — the
  authoritative producer of every L1 value (D-001). `ALGORITHM_VERSION = 1`.

## 5. Data Model (Drizzle)

All values are canonical SI (m/s, m, °C — D-006). Enums added in `src/db/schema.ts`:
`activity_status`, `activity_source`, `activity_condition_kind`, `activity_privacy`,
`effort_type`, `equipment_type` (plus the cross-cutting `sport` enum from RFC-0003). Migration
generated with `npm run db:gen`; because the DB was never applied in this environment, all
migrations were re-consolidated to a single clean base (`0000_clean_azazel`, [[../otonom-kararlar]]
§28/§30).

### The 4-layer model (why)

| Layer | What | Mutation | Tables (P0) |
| ----- | ---- | -------- | ----------- |
| **L0 Raw** | the immutable record of the session | write-once, **never changes** | `activity` (identity), `activity_track`, `activity_condition` |
| **L1 Derived** | computed analysis | **recomputable** with an algorithm version | `activity_summary`, `activity_route`, `activity_effort` |
| **L2 Correction** | user's manual override | separate rows, never touch L0/L1 | *(P1 — `activity_correction`)* |
| **L3 Context** | user-entered context | freely editable | columns on `activity` + `activity_equipment` |

The split is the domain's backbone: because L1 is a **pure function of L0** carrying its input
provenance, we can improve the engine and re-derive every stored session without a re-upload or
an app release — the whole reason canonical metrics live server-side (D-001).

### Tables

**`activity`** — L0 identity + status + provenance + inline L3 context.

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` / `uid` | int identity / text uuid | internal PK / public id (client-generated on upload) |
| `userId` | int → `user.id` | owner |
| `sport` | `sport` enum | windsurf / wingfoil / sailing / other (+ more) |
| `customName` | text? | L3 |
| `status` | `activity_status` | default `processing` |
| `source` | `activity_source` | default `iphone`; **watch-ready from P0** |
| `dataVersion` | int, default 1 | provenance of the raw track behind current L1; stored on each summary as `inputDataVersion`. Reserved for a future corrected-track re-upload — P0 uploads are write-once so it stays `1`; recompute keys off `ALGORITHM_VERSION`, not this. |
| `startedAt` / `endedAt` / `timezone` | timestamptz(3) / text | session time |
| `spotUid` / `spotName` | text? | **loose** ref to `watersport_spot` by `uid` (keeps the activity domain decoupled from spot's internal ids) + denormalized name |
| `startLat/Lon`, `endLat/Lon` | double? | coarse geo, filled from the first/last sample |
| `device` / `deviceModel` / `osVersion` / `appVersion` | text? | provenance |
| `notes` / `feeling` / `tags[]` / `perceivedEffort` | text? / text? / text[] / int? | L3 context |
| `privacy` | `activity_privacy` | default `private` (`private|followers|public`) |
| `hideStart` / `hiddenRadiusM` | bool / real? | privacy-fuzzing intent (stored, not enforced in P0 — §10) |
| `createdAt` / `updatedAt` | timestamptz(3) | |

Indexes: `activity_user_started_idx (userId, startedAt)` serves the reverse-chronological list;
`activity_user_sport_idx (userId, sport)` serves the sport filter. FK `userId → user.id` (no
cascade — a user is retired/merged, not hard-deleted; D-008 reassigns instead).

**`activity_track`** — L0 raw pointer (one row per activity). `activityId` is `.unique()` +
`onDelete: "cascade"`. Columns: `sampleCount int`, `storageKey text NOT NULL`. **The samples
themselves are NOT here** — `storageKey` resolves to an S3 object of gzipped JSON
`Sample[]`. This is the §30 change: the old `samples jsonb` column was removed. A 200k-sample
track is ~16 MB of JSON; that does not belong in a Postgres row.

**`activity_condition`** — L0 weather snapshot. `unique(activityId, kind)` so forecast and
observed can coexist as one row each. Columns: `provider?`, `windSpeedMs`, `windGustsMs`,
`windDirectionDeg`, `temperatureC`, `weatherCode`, `capturedAt`. `onDelete: cascade`.

**`activity_summary`** — L1 core summary (one row per activity, `activityId` unique,
`onDelete: cascade`). `totalDistanceM`, `maxSpeedMs`, `avgSpeedMs`, `avgMovingSpeedMs`,
`durationSec`, `movingDurationSec`, `maxDistanceFromStartM?`, `validSampleCount`, `gapCount` +
the L1 metadata `algorithmVersion`, `inputDataVersion`, `computedAt`.

**`activity_route`** — L1 render polyline (one row, `activityId` unique, cascade): `polyline`
(Google-encoded), `algorithmVersion`, `computedAt`. (Simplified LOD tiers are P1.)

**`activity_effort`** — L1 best efforts, **one row per effort** (a table, not jsonb, so
cross-session records/insights in RFC-0007 can query it). `type` (`effort_type`), `resultMs`
(avg m/s over the window), `durationSec?`, `distanceM?`, `startOffsetSec?` (seconds from start),
`algorithmVersion`, `computedAt`. `unique(activityId, type)` — each effort type is a single best
per session, which makes recompute a clean upsert/replace. `onDelete: cascade`.

**`equipment_profile`** — reusable per-user gear library: `userId → user.id`, `type`
(`equipment_type`), `name`, `attributes jsonb .$type<JsonValue>()` (type-specific:
volume/size/mast/boom/fin/frontWing…).

**`activity_equipment`** — the M:N link with a **snapshot**. `activityId` (cascade),
`equipmentProfileId → equipment_profile.id`, `role?`, `snapshot jsonb` (the profile's
attributes at record time). `unique(activityId, equipmentProfileId)`. **No `onDelete` on the
profile FK** — there is no equipment-delete endpoint in P0, so the `RESTRICT`-vs-snapshot-keep
decision is deferred (§16).

`effort_type` enum (P0): `time_{2s,5s,10s,20s,30s,1m,5m}`, `dist_{100m,250m,500m,1km,nm}`,
`best_5x10`.

## 6. API Surface (routes + OpenAPI)

All endpoints require an authenticated principal (`c.var.user`) via the `authenticate`
middleware, which accepts **both** our anonymous device JWT **and** a real Clerk token
(RFC-0002). Anonymous users get real sessions; D-008 moves them to the Clerk account on merge.
Routes mount at `/v1/activities` and `/v1/equipment`.

| Method | Path                    | Auth | Summary                                        |
| ------ | ----------------------- | ---- | ---------------------------------------------- |
| POST   | `/v1/activities`        | user | Upload a session (gzip body, idempotent)       |
| GET    | `/v1/activities`        | user | List the user's activities (summary)           |
| GET    | `/v1/activities/:uid`   | user | Activity detail (summary + route + efforts + conditions) |
| PATCH  | `/v1/activities/:uid`   | user | Update L3 context (notes/feeling/tags/privacy) |
| DELETE | `/v1/activities/:uid`   | user | Delete an activity (children cascade)          |
| GET    | `/v1/equipment`         | user | List the user's equipment library              |
| POST   | `/v1/equipment`         | user | Create an equipment profile                    |

### POST /v1/activities — upload

- **Auth:** user (anonymous JWT or Clerk).
- **Request:** `Content-Encoding: gzip` body of `createActivitySchema` (JSON). Key fields:
  `uid` (`z.string().uuid()`, **client-generated** → idempotent), `sport`, `source`
  (default `iphone`), `startedAt` (ISO), optional `endedAt`/`timezone`/`spotUid`/`spotName`/
  device fields, `samples` (`array(sampleSchema).max(200_000)`), optional `conditions`
  (forecast snapshot), optional `equipment` (`max(20)` of `{ equipmentUid, role? }`).
  `sampleSchema` bounds `lat ∈ [-90,90]`, `lon ∈ [-180,180]`, `speed ≥ 0`, `hAccuracy ≥ 0`.
- **Limits / hardening:** `rateLimit` 30/min keyed `activity-upload`; `bodyLimit`
  `maxSize = 24 MiB` (on the wire); gunzip is **async** with `maxOutputLength = 64 MiB`
  inflated (§7 — the DoS story).
- **Response:** `{ data: { uid, status } }` (`CreateActivityResponse`), typically
  `status = "processing"`. 200 on both the first upload and an idempotent retry.
- **Errors:** `FORM_ERROR` (`ACTIVITY_INVALID_UPLOAD`, 400) for un-gunzippable / non-JSON /
  schema-invalid bodies and for `bodyLimit` overflow (413); `ALREADY_EXISTS`
  (`ACTIVITY_ALREADY_EXISTS`, 409) when the `uid` belongs to a **different** user.
- **Example:**
  ```http
  POST /v1/activities   Content-Encoding: gzip
  { "uid":"7b1f…","sport":"windsurf","startedAt":"2026-07-11T09:00:00Z",
    "samples":[{"t":0,"lat":38.30,"lon":26.36,"speed":9.8,"hAccuracy":4,"sAccuracy":0.6}, …],
    "conditions":{"windSpeedMs":11.3,"windDirectionDeg":315},
    "equipment":[{"equipmentUid":"…","role":"sail"}] }
  → 200 { "data": { "uid":"7b1f…", "status":"processing" } }
  ```

### GET /v1/activities — list

- **Request (query):** `listActivitiesQuerySchema` — `sport?`, `limit` (coerced int,
  `≤100`, default `30`).
- **Response:** `{ data: { activities: [...] } }` (`ActivityListResponse`); each item is
  `{ uid, sport, customName, status, startedAt, spotName, summary }` where `summary` is the
  nullable `ActivitySummary` DTO. Ordered `startedAt desc` via the `(userId, startedAt)` index.

### GET /v1/activities/:uid — detail

- **Request (param):** `activityUidParamSchema` (`uid` uuid).
- **Response:** `ActivityDetailResponse` — the activity's public fields + `summary`, `polyline`,
  `efforts[]`, and `conditions[]`, assembled by four parallel repository reads.
- **Errors:** `NOT_FOUND` (`ACTIVITY_NOT_FOUND`, 404) when the uid is not the caller's (reads
  are user-scoped, so another user's activity is indistinguishable from a missing one).

### PATCH /v1/activities/:uid — context

- **Request:** `patchActivitySchema` — every field optional; `customName`, `notes`, `feeling`,
  `tags`, `perceivedEffort` (`1..10`), `hiddenRadiusM` are `.nullable()`; `privacy`, `hideStart`.
  Only provided keys are written (a `PATCH`, not a replace).
- **Response:** `204 No Content`. **Errors:** `NOT_FOUND` (404) when not the caller's.

### DELETE /v1/activities/:uid

- **Response:** `204`. Deleting the `activity` row cascades to track/condition/summary/route/
  effort/equipment children. **Errors:** `NOT_FOUND` (404).

### GET / POST /v1/equipment

- **GET** → `{ data: { equipment: [...] } }` (`EquipmentListResponse`), each
  `{ uid, type, name, attributes }`, newest first.
- **POST** `createEquipmentSchema` — `{ type, name (1..120), attributes? }` →
  `{ data: EquipmentResponse }`.

## 7. Services & Business Logic

Three services, all `extends BaseUseCase` (no DB access — only `this.config`). Cross-cutting
infra (the raw-track blob store) is injected as the `ObjectStorage` **port**, never the concrete
S3 client.

### ActivityService

`create(user, input)` — store an uploaded session and enqueue compute. The method threads three
independent correctness properties:

1. **Idempotency (create).** `activityRepository.createActivity` inserts with
   `onConflictDoNothing({ target: uid })` and, on conflict, re-reads the existing row. A retried
   upload returns the existing activity instead of duplicating.
2. **Ownership guard (write-side IDOR — [[../otonom-kararlar]] §29).** Immediately after create,
   if `activity.userId !== user.id` the client `uid` collided with **another user's** activity
   → throw `ALREADY_EXISTS` (409) **before** any child insert or enqueue. Without this, an
   attacker who guesses/knows a uid could overwrite a victim's track or leak the victim's
   location. UUIDv4 unpredictability is not the only defense (the uid appears in URLs/logs and
   is on the public-sharing roadmap).
3. **Ingest exactly once, but recover a stranded enqueue.** `trackExists(activityId)` (a cheap
   `id`-only probe that never pulls the samples pointer) gates L0 ingest:
   - If not yet ingested: resolve equipment links, **write the gzipped track to S3 first**
     (external I/O must not sit inside a DB transaction; the key is deterministic so a retry
     overwrites the same object), then `ingestTrack` (track + conditions + equipment links in
     **one transaction**).
   - **Enqueue is keyed on `status === "processing"`, NOT on track existence.** So an upload
     whose first enqueue failed (dev has no Trigger; a transient outage) re-enqueues on retry
     instead of stranding forever in `processing`. `computeAndStore` is idempotent, so a rare
     double-enqueue (concurrent uploads) is harmless; a `failed` activity is deliberately left
     alone (re-uploading the same immutable track cannot change the outcome — recompute is a
     separate seam via `ALGORITHM_VERSION`).

   Returns `{ uid, status }`.

`resolveEquipmentLinks(userId, activityId, equipment)` — resolves each upload ref to an
**owned** `equipment_profile` (`findByUidForUser`) and snapshots its `attributes`. An unresolved
ref is **skipped** (best-effort attach must never fail a session upload) but `log.warn`-ed so the
drop is observable. (This is why there is no `EQUIPMENT_NOT_FOUND` error — §29.)

`list` / `detail` / `patchContext` / `remove` — user-scoped throughout. `detail` runs four
parallel reads (summary, route, efforts, conditions) and maps to DTOs; a missing row 404s.

### ActivityMetricsService

`computeAndStore(activityUid)` — the canonical L1 producer, invoked only by the Trigger task:

1. `findByUid` → 404 if gone.
2. In a `try`: `findTrackByActivityId` → `loadSamples(storageKey)` (S3 `get` → `gunzip` →
   `JSON.parse`) → `computeMetrics(samples)` (the pure engine).
3. `upsertSummary` (with `algorithmVersion = ALGORITHM_VERSION`, `inputDataVersion =
   activity.dataVersion`, `computedAt`), `upsertRoute`, `replaceEfforts` (delete-then-insert for
   a clean recompute), `setStatus("ready")`.
4. On any throw: `setStatus("failed")` and rethrow (the task's retry/observability handle it;
   the immutable track is untouched, so a later recompute can retry).

Idempotent and re-runnable — this is the **recompute-on-`ALGORITHM_VERSION`** seam.

### The canonical metric engine (`metrics.ts`, D-001)

Pure, unit-tested, DB/HTTP-free, all SI. `computeMetrics(rawSamples): { summary, efforts,
polyline }`. `ALGORITHM_VERSION = 1`. Tuning constants:

| Constant | Value | Meaning |
| -------- | ----- | ------- |
| `MAX_HACCURACY_M` | 25 m | drop samples worse than this horizontal accuracy |
| `MAX_SPEED_MS` | 40 m/s (~78 kt) | implausible → GPS spike |
| `MAX_SACCURACY_MS` | 2 m/s | a Doppler reading may only set `maxSpeed` if its `speedAccuracy` is this good |
| `MAX_SPEED_CORROBORATION` | 0.5 | …and position-derived speed must corroborate ≥ 50% of it |
| `MOVING_THRESHOLD_MS` | 1 m/s | below this a sample is "not moving" |
| `GAP_THRESHOLD_SEC` | 5 s | a larger inter-sample gap is a tracking gap |
| `MIN_SESSION_SEC` / `MIN_VALID_SAMPLES` | 60 s / 20 | below either → summary + route but **no efforts** |

Pipeline:

1. **`cleanSamples`** — drop non-finite `t/lat/lon`, out-of-range coordinates, and samples with
   `hAccuracy > 25 m`; sort chronologically; dedupe by keeping only strictly-increasing
   timestamps (identical/backwards fixes are dropped).
2. **Main pass** (per adjacent pair, building `t[]` and cumulative-distance `cumDist[]`):
   - `segDist = haversine(prev, cur)`; **position spike rejection** — if `segDist / dt >
     40 m/s`, set `segDist = 0` (a rejected segment contributes nothing and can never leak the
     40 m/s cap into `maxSpeed`). `derived = segDist / dt`.
   - **Doppler-vs-derived speed:** prefer the device Doppler `speed` when present, in `[0, 40]`,
     and not accuracy-flagged (`sAccuracy == null || ≥ 0`); else fall back to the spike-rejected
     `derived`.
   - Accumulate `totalDistance`; count a gap if `dt > 5 s`; if `speed > 1 m/s` accumulate
     **`movingTime` and `movingDistance`** (same gate).
   - **`maxSpeed` corroboration** (single-sample-sensitive): a Doppler reading may set
     `maxSpeed` only when `dopplerOk` **and** its `speedAccuracy ≤ 2 m/s` **and** the
     position-`derived` speed is `≥ 0.5 ×` the Doppler value; otherwise the (already
     spike-rejected) `derived` speed is used. This stops one bad fix from becoming the headline
     max ([[../otonom-kararlar]] §29).
   - Track `maxDistanceFromStartM` (haversine to the start point).
3. **Summary:** `durationSec = lastT − firstT`; `avgSpeedMs = totalDistance / durationSec`;
   **`avgMovingSpeedMs = movingDistance / movingTime`** — deliberately moving-**distance** ÷
   moving-time, NOT total distance, so idle drift (rig time, waiting for a gust, water-starts)
   can't inflate the moving average (the §29 HIGH fix; regression-tested).
4. **Polyline:** Google encoded-polyline over every cleaned sample.
5. **Too-short guard:** if `durationSec < 60` or `< 20` valid samples → return summary + route
   with **no efforts** (a 100 m effort at 1 Hz is on the edge of meaningful —
   [[research/gps-tracking]]).
6. **Efforts** (only past the guard):
   - **Best time efforts** (`bestTimeEffort`, two-pointer) — for each window in
     `{2s,5s,10s,20s,30s,1m,5m}` with `durationSec ≥ window`, the best average speed over any
     window of **≥ window** seconds (`(cumDist[j] − cumDist[i]) / dt`), plus `startOffsetSec`.
   - **Best distance efforts** (`bestDistanceEffort`, two-pointer) — for each distance in
     `{100,250,500,1000,1852}` m with `totalDistance ≥ distance`, the fastest average speed to
     cover **≥ distance** metres.
   - **`best5x10`** — build every ≥10 s window, sort by speed desc, **greedily** pick the 5 best
     **non-overlapping** ones, average them (null if fewer than 5 exist). Greedy is admittedly
     non-optimal (a fast window can block two neighbors with a larger sum) — accepted in P0 given
     the D-001 "not an official record" stance (§16).

`SummaryValues`, `EffortValue`, `MetricsResult`, and the `Sample` interface are exported for the
service + tests.

### EquipmentService

`list(user)` / `create(user, input)` — thin CRUD over the per-user library. No cross-session
logic; the snapshot-onto-activity happens in `ActivityService.resolveEquipmentLinks`.

### Repositories

`ActivityRepository` and `EquipmentRepository` extend `BaseRepository` (the only holders of
`this.dbClient` + Drizzle operators). Every read uses an explicit **column allowlist** (never
`SELECT *`, mirroring `SpotRepository` — §29), so a future private/large column never surfaces
implicitly. Notable methods: `createActivity` (idempotent upsert-on-uid), `trackExists`
(id-only probe), `ingestTrack` (the one L0 transaction: track + conditions + equipment links,
all conflict-safe so a retry is a no-op), `upsertSummary`/`upsertRoute` (conflict-on-activityId
upserts), `replaceEfforts` (delete-then-insert), and `reassignOwner(from, to, tx)` on both repos
(the D-008 hook, threaded an opaque `DBExecutor`).

## 8. Background Jobs (Trigger.dev)

**`activity-compute-metrics`** (`activity-compute-metrics.{schema,task,trigger}.ts`).

- **Payload:** `{ activityUid: uuid }`.
- **Task:** a `schemaTask` following the Splash pattern — `initializeForTrigger()` +
  `createDBManagerForTrigger()` (per-task pool) + `buildContainer(dbManager)` inside `try`,
  `logger.trace("compute-metrics", …)` around `activityMetricsService.computeAndStore(uid)`,
  `Tracking.captureException` on error, and always `finalizeTrigger(dbManager)` in `finally`.
  `maxDuration: 300`, `retry: { maxAttempts: 3 }`.
- **Invoked from:** `ActivityService.create` via `triggerActivityComputeMetrics(uid)` (a service,
  never a route). The trigger wrapper is mocked in the service spec so unit tests don't touch
  Trigger.
- **Idempotency / recompute.** The task is safe to run repeatedly (summary/route are upserts,
  efforts are replaced, `setStatus` is a plain write). This is the **recompute seam**: when
  `ALGORITHM_VERSION` bumps, re-enqueuing over existing tracks re-derives all L1 without any
  app change. A periodic reconciliation cron ("`processing` for N minutes with a track present →
  re-enqueue") would be belt-and-suspenders but is deferred (§16); the status-keyed enqueue
  already recovers the common stranded case on the next upload retry.

## 9. Dependencies & Integrations

- **Object storage (new — [[../otonom-kararlar]] §30).** `ObjectStorage` port in
  `src/packages/object-storage` (`put/get/delete`), with the `S3ObjectStorage` adapter over
  `@aws-sdk/client-s3` (S3/R2/MinIO-compatible via `endpoint` + `forcePathStyle`). Config is read
  **lazily on first use** so `new S3ObjectStorage()` stays config-free and constructible at
  `buildContainer` time (before `globalConfig.initialize()`), matching `OpenMeteoClient`. Env:
  `OBJECT_STORAGE_{BUCKET,REGION,ENDPOINT,ACCESS_KEY_ID,SECRET_ACCESS_KEY,FORCE_PATH_STYLE}`.
  `REGION` defaults to `auto`; the adapter throws a clear `EXTERNAL_SERVICE_ERROR` if used
  without a bucket. **`OBJECT_STORAGE_BUCKET` is required in prod** (a `superRefine` gate),
  because both the HTTP upload (`put`) and the Trigger worker (`get`) use it — so it can't be
  role-scoped.
- **Weather (RFC-0005).** The upload carries the forecast the app already showed; stored as an
  `activity_condition` row (`kind = forecast`). Observed conditions are a later phase.
- **Spot (RFC-0004).** Referenced loosely by `spotUid` + denormalized `spotName`; no hard FK.
- **Identity/auth (RFC-0002).** `authenticate` (both token types) and the D-008 merge seam.
- **Seams exposed for later RFCs.** `activity_effort` / `activity_summary` for cross-session
  **records/insights** (RFC-0007); the `activityReassigner` for merge (already wired); the
  recompute enqueue for an ops/reconciliation cron.

## 10. Security & Privacy

- **Ownership / user-scoping.** Every read and mutation is scoped to `user.id`; a non-owned uid
  is a 404, and the **write-side IDOR** on the idempotent upload is closed by the ownership guard
  (§7, §29). Raw location tracks are sensitive PII and are owned by the user.
- **Anonymous + Clerk.** Both principals get real sessions; D-008 moves an anonymous user's
  activities **and** equipment to the Clerk account inside the merge transaction (the
  `activityReassigner` runs `activityRepository.reassignOwner` + `equipmentRepository.reassignOwner`).
- **Upload hardening (the §29 CRITICAL fix).** The upload endpoint reads the raw (compressed)
  body itself, so it is the one place that must resist a decompression bomb: `bodyLimit`
  (`24 MiB` on the wire) rejects before fully buffering; `gunzip` is **async** (never blocks the
  event loop) with `maxOutputLength = 64 MiB` (an over-inflating payload raises `RangeError`);
  and the whole decompress+parse is `try/catch`-wrapped so a malformed/oversized body is a clean
  `400 INVALID_UPLOAD`, not an unhandled 500 that pages ops. Plus a `rateLimit` of 30 uploads/min.
- **Privacy fields stored but not yet enforced.** `privacy` / `hideStart` / `hiddenRadiusM` are
  persisted, but `detail` returns the full polyline. This is harmless in P0 (everything is
  owner-scoped; there is **no public sharing surface**), but **must be enforced** when sharing
  lands — that is that future RFC's job (§16).
- **Encryption at rest** for the S3 track blobs is a deployment concern (bucket-level).

## 11. Observability

- **Structured logs** via `createLogger` scopes: `ActivityService` (skipped equipment refs),
  `ActivityMetricsService` (`"Activity metrics computed"` with effort count), and
  `object-storage` (put/get/delete failures with the key).
- **Exceptions vs. expected errors.** The Trigger task reports genuine failures via
  `Tracking.captureException` (taskId + activityUid). Expected `GenericError`s
  (`INVALID_UPLOAD`, `NOT_FOUND`, `ALREADY_EXISTS`) are returned to the client without paging,
  per the central error-handler policy (RFC-0001). The §29 fix specifically moved malformed
  uploads out of the captureException path.
- **Status as a signal.** `activity.status` (`processing`/`ready`/`failed`) is the queryable
  health of the compute pipeline (and the natural target of a future reconciliation cron).

## 12. Performance & Scalability

- **Payload sizing** ([[research/gps-tracking]]): ~1 Hz iPhone GPS ⇒ a 1–2 h session is
  ~0.2–1.2 MB raw JSON, ~50–250 KB gzipped; even a 3 h session stays under ~2 MB raw / ~400 KB
  gzipped. One request, no chunking. The `samples.max(200_000)` cap (~200k = a very long
  session) plus the byte caps bound the worst case.
- **Postgres stays lean.** The big blob is in S3; Postgres rows are small and indexed for the
  two hot queries (list by `(userId, startedAt)`, filter by `(userId, sport)`). The idempotency
  probe (`trackExists`) is `id`-only, so an upload retry never pulls a 16 MB blob.
- **Compute is off the request path.** The canonical engine runs in a Trigger worker with its
  own pool, so a large track never occupies the HTTP pool; the upload returns as soon as the
  track is stored + enqueued.
- **Deferred until volume warrants it:** polyline LOD tiers (a 2 h session is ~7200 points, sent
  full-res in `detail` today), and a reconciliation cron (§16).

## 13. Testing Strategy

Co-located specs, all deps (repositories, `ObjectStorage`, the Trigger wrapper) mocked:

- **`metrics.spec.ts`** — the engine on synthetic tracks: distance/speeds/duration on a
  constant-speed track; time + distance + 5×10 efforts; **no efforts for a too-short session**
  (but a summary); **GPS spike rejection** (a teleport sample doesn't inflate distance);
  low-accuracy sample dropping; Doppler-absent fallback to position-derived speed; empty/one-
  sample graceful path; **`avgMovingSpeed` not inflated by idle drift** (the §29 regression);
  and **a lone bad Doppler reading not setting `maxSpeed`** (the corroboration regression).
- **`activity.service.spec.ts`** — fresh ingest enqueues + writes the track to object storage
  (key + count only in the DB); a `ready` retry re-ingests nothing and re-enqueues nothing; a
  **still-`processing` retry re-enqueues without re-ingesting** (durability); a **foreign-uid
  upload is rejected 409** before any child write; detail/patch/remove 404 paths.
- **`activity-metrics.service.spec.ts`** — computes + stores summary/route/efforts and marks
  `ready` (feeding a real `gzipSync` blob through the mocked `ObjectStorage.get`); NOT_FOUND;
  and **marks `failed` + rethrows** on a downstream error.
- **`equipment.service.spec.ts`** — create/list happy paths.
- **Manual smoke test required before shipping (§16).** The `S3ObjectStorage` adapter itself is
  **not integration-tested here** — this environment has no bucket/credentials (like the blocked
  Docker registry). It is a thin, well-understood SDK wrapper, and the service tests give real
  coverage by **mocking the port** (does upload call `put`; does metrics `get → gunzip → parse`).
  Once a real bucket + credentials are connected, run one manual smoke test end-to-end (upload →
  object present in S3 → metrics computed).

## 14. Alternatives Considered

- **Raw track in Postgres (`bytea`/jsonb) vs. object storage.** The original open question
  ([[research/gps-tracking]] §4). Resolved to **S3 object storage** (Berkay, [[../otonom-kararlar]]
  §30): a 16 MB blob does not belong in a Postgres row, S3 is cheap and scales, and a port lets
  a future R2 swap or presigned two-phase direct upload change one adapter without touching
  services (DIP, the `WeatherProvider` pattern).
- **Trust the device's live metrics.** Rejected by D-001 — the device is "fast but approximate";
  the backend is the single canonical engine so phone/watch/web agree and improvements re-derive
  stored tracks. The device numbers remain, for live UX only.
- **Efforts as jsonb on the summary.** Rejected — a per-effort **table** lets cross-session
  records/insights (RFC-0007) query `activity_effort` directly.
- **Optimal (DP) 5×10 selection.** Deferred — greedy is non-optimal but adequate given the
  non-official-record stance (§16); an exact solution needs dynamic programming.
- **Enqueue keyed on track existence.** Rejected during review (§29) — it strands a session in
  `processing` if the first enqueue fails; keying on `status === "processing"` self-recovers.

## 15. Implementation Plan (checklist)

1. ✅ Enums + 8 tables in `src/db/schema.ts` (+ `dbSchema`, inferred types); `db:gen` →
   consolidated `0000` migration.
2. ✅ `errors.ts` (`ActivityReason`), `schemas/index.ts` (upload/patch/equipment requests +
   `.describe()`/`.meta({ ref })` responses).
3. ✅ `packages/object-storage` — `ObjectStorage` port + `S3ObjectStorage` adapter; config vars
   + prod refine in `global-config.ts`; `.env.sample`.
4. ✅ Repositories (`ActivityRepository`, `EquipmentRepository`) with column allowlists,
   `trackExists`, transactional `ingestTrack`, `reassignOwner`.
5. ✅ `metrics.ts` — the pure canonical engine (+ `metrics.spec.ts`).
6. ✅ Services (`ActivityService`, `ActivityMetricsService`, `EquipmentService`) + co-located
   specs.
7. ✅ `activity-compute-metrics.{schema,task,trigger}.ts`.
8. ✅ `routes/v1.ts` (`activityRoute`, `equipmentRoute`) with `bodyLimit` + async-gunzip
   `readGzipBody` + `rateLimit`.
9. ✅ `activity.module.ts` (`createActivityModule`, exposes services + `activityReassigner`);
   wired into `src/container.ts` (reassigner threaded to auth) and `src/domains/index.ts`
   (`/v1/activities`, `/v1/equipment`).
10. ✅ `lint:biome:fix` / `lint:type` / `lint:imports` / `test` green; convention + principal
    reviews folded in (§29).

## 16. Open Questions & Resolved Decisions

- ~~Raw track: Postgres blob or object storage?~~ → **S3 object storage** (Berkay, 2026-07-11,
  [[../otonom-kararlar]] §30). ✅
- **Exact P0 canonical metric set** — aligned with the app's speedsurfing metrics
  (`AnalyticsModels.swift`) per [[metrics-catalog]] family A, but the precise "from the app" set
  **still needs Berkay's confirmation**. ⏸️
- **S3 adapter not integration-tested here** — needs a one-off **manual smoke test** against a
  real bucket + credentials before shipping (§13). ⏸️
- **Deliberately deferred to P1 (accepted in P0 — [[../otonom-kararlar]] §29):**
  - `best5x10` greedy selection is non-optimal (a fast window can block a better-summing pair);
    exact needs DP.
  - Efforts are **position-derived** (not Doppler-integrated) — reasonable at 1 Hz phone GPS and
    consistent with the non-official stance.
  - **Privacy is stored but not enforced** — `detail` returns the full polyline; must be
    enforced when public sharing lands (that RFC's job).
  - **No reconciliation cron** — status-keyed enqueue recovers on retry; an "`processing` for N
    min → re-enqueue" cron (also the recompute entry point) is deferred to RFC-0007/ops.
  - **Full-res polyline (no LOD)** — `activity_route.simplified` tiers are P1.
  - **`activity_equipment → equipment_profile` FK has no `onDelete`** — there is no
    equipment-delete endpoint in P0; the `RESTRICT`-vs-snapshot decision waits for one.
  - **Same uid + different samples is silently ignored** — correct for a genuine retry (L0 is
    write-once); a divergent re-upload could be signaled via a content hash if wanted.

## 17. References

[[activity-data-model]] · [[research/gps-tracking]] · [[metrics-catalog]] (family A) ·
[[decisions]] (D-001 canonical metrics, D-006 units, D-008 merge) · [[../otonom-kararlar]] §28
(schema refinements), §29 (dual-review fixes), §30 (S3 storage) · [[architecture]] ·
[[0001-foundation]] · [[0002-identity-auth]] · [[0004-spot]] · [[0005-weather]]
