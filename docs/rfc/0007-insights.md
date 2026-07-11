# RFC-0007: Insights (Records, Trends & Aggregates)

|                |                                        |
| -------------- | -------------------------------------- |
| **RFC**        | 0007                                   |
| **Title**      | Insights (Records, Trends & Aggregates) |
| **Status**     | 🗓️ Deferred |
| **Step**       | 6                                      |
| **Depends on** | RFC-0006                               |
| **Domain(s)**  | feature/insights                       |
| **Updated**    | 2026-07-11                             |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected
> **Lifecycle:** set `🚧 In Progress` when implementation starts; `✅ Completed` when done. If a
> decision changes during implementation, update the RFC to match what was actually built.
>
> **This RFC is a forward-looking design proposal, not an as-built record.** Nothing in
> `src/domains/feature/insights` exists yet. Implementation is deliberately deferred behind the
> RFC-0001…0006 build (Berkay's decision 2026-07-11 — insights + alerts + monetization come
> last; [[../otonom-kararlar]] §0). This document is written at full depth now so that when the
> phase opens the only open input is the *final* metric/insight list Berkay pulls from
> `AnalyticsModels.swift` (§16).

---

## 1. Summary

This RFC designs the **insights** bounded context: the cross-session layer that turns a user's
accumulated activities into **personal records** (all-time bests per effort type and per
summary metric, per sport), **trends over time** (distance / max speed / session count bucketed
by week, month, season, year), **lifetime aggregates and streaks**, and — evidence-gated — the
derived "fastest conditions / fastest spot / fastest equipment" patterns. Where RFC-0006
answers *"what happened in this session?"*, RFC-0007 answers *"how does this session compare to
everything before it, and how am I trending?"*.

The single most important design choice is **how these are computed**. Per-session metrics are
already computed once and stored on the row at write time (RFC-0006 canonical compute, [[decisions]]
D-001; the schema-per-period-query rationale is [[decisions]] D-005). That makes a pure
read-time aggregation *possible*, but two facts push us to a **hybrid**: (a) `activity_summary`
and `activity_effort` key off `activityId` and carry **no denormalized `userId`/date**, so
every read-time query must join back to `activity`; and (b) all-time **records** have no
per-user index to lean on, so a read-time "best ever" query scans the user's whole effort
history and gets slower the more the user rides. The chosen design therefore **materializes two
small insights-owned rollup tables** — `user_record` (one row per user × sport × record type)
and `user_period_stat` (one row per user × sport × period bucket) — **maintained incrementally
by a hook** the moment RFC-0006's metric task finishes an activity, and **reconciled nightly**
by an authoritative recompute cron. Read-time source aggregation (the join path over
`activity` + `activity_summary` + `activity_effort`) is retained as the recompute/backfill
engine and a correctness fallback, not the hot path. Join-heavy, evidence-gated patterns land
in a short-TTL `insight_cache`.

## 2. Motivation & Context

- **Problem.** The iOS app already renders an insights surface (`AnalyticsModels` + `Insights`,
  `SummaryMetric`, `ActivityPeriod`) on **sample data**. RFC-0006 now records real sessions and
  computes canonical per-session metrics, but nothing aggregates *across* sessions. Without this
  layer the profile screen (period summary cards, personal records, streaks) has no backend and
  the app's insights stay simulated. The catalog of what belongs here is [[metrics-catalog]] §C.
- **Background.** This is the backend home of the app's `AnalyticsModels.swift`
  (`Insights` / `SummaryMetric` / `ActivityPeriod`). It reads the L1 tables shipped by
  RFC-0006 ([[activity-data-model]] §1 — `activity_summary`, `activity_effort`) plus the
  `activity` L0 identity row for `userId` / `sport` / `startedAt` / `spotUid`. The schema
  strategy was pre-decided in [[decisions]] D-005 ("schema follows the period query — per-session
  metrics stored on the row, insight/period queries aggregate cheaply over an index"). Units are
  canonical SI throughout ([[decisions]] D-006). The evidence-threshold discipline ("never claim
  causality; hide an insight until there is enough comparable data") comes from [[metrics-catalog]] §C.
- **Deferred by decision.** Berkay marked 0007–0009 `🗓️ Deferred` (monetization + insights +
  alerts last, [[../otonom-kararlar]] §0). This RFC is authored ahead of the build so the design
  is settled; the meta table is `🟡 Draft` (design under review), *not* In Progress. It sits at
  **Step 6**, directly on top of RFC-0006.
- **Goals.**
  - All-time **personal records** per sport: max speed, best 5×10, longest single-session
    distance/duration, and every best-effort window (2 s…5 m, 100 m…1 NM), each with the
    session that set it.
  - **Trends**: a time series of a chosen metric (distance / max speed / sessions / …) bucketed
    by week / month / season / year, and a **period summary** (4 cards + delta vs the previous
    period) that adapts its card slots to the user's sport + goal (RFC-0003 `user_sport_profile`).
  - **Lifetime aggregates + streaks**: total sessions/distance/time/active-days and the
    current/longest active-week streak, for the profile header.
  - A computation model that keeps the **profile screen O(1) to read** as a user's history grows
    into the thousands of sessions, updates records **immediately** after a session is processed,
    and stays **correct under delete / edit / recompute / account merge**.
- **Non-goals.**
  - ML / predictive recommendations, "you'd go faster if…" causal claims (explicitly out —
    [[metrics-catalog]] §C).
  - Social / leaderboard comparison across users. Insights are strictly the user's own aggregates
    (belongs to a later social phase, not this RFC).
  - Recomputing per-session metrics — that is RFC-0006's job (D-001). This RFC only *aggregates*
    already-computed L1 rows; it never touches raw tracks or the metric algorithm.
  - Forecast-vs-reality trend summaries and the advanced sailing insights (VMG/polar) — these
    depend on L1 tables that are RFC-0006 P1/P2 (`activity_condition` observed rows,
    `activity_interval`, `wind_relative`) and are noted as fast-follows in §3/§16.

## 3. Scope (In / Out)

- **In:**
  - Domain `feature/insights` with the standard layer stack (route → service → repository →
    drizzle), a `insights.module.ts`, and wiring into `src/container.ts`.
  - Three new tables (`user_record`, `user_period_stat`, `insight_cache`) + two enums
    (`recordTypeEnum`, `insightKeyEnum`); `activityPeriodEnum` / `sportEnum` / `summaryMetricEnum`
    reused from the existing schema.
  - Read endpoints: `records`, `trends`, `summary` (period cards + delta), `profile` (lifetime +
    streaks). Evidence-gated `patterns` (fastest conditions/spot/gear) as a documented P1-within-insights.
  - `InsightsService` (read methods + the `onActivityComputed` maintenance hook +
    `recomputeForUser` authoritative rebuild), `InsightsRepository`.
  - A **seam addition to RFC-0006**: the shipped `activity-compute-metrics` task and the
    activity module must invoke the insights maintenance port (see §7/§9 — this is the only edit
    outside the new domain).
  - A nightly `insights-nightly-rollup` cron + an on-demand `insights-recompute-user` task (used
    by algorithm-version bumps and account-merge).
  - A `MergeReassigner` for insights rollups (D-008 seam).
- **Out (deferred / another RFC):**
  - Evidence-gated **patterns** beyond the three named ones, and forecast-vs-reality summaries
    (depend on RFC-0006 P1 `activity_condition` observed + `activity_interval`).
  - Alerting/notifications off a record being broken ("new personal best!") — that is RFC-0008/0009
    (notification transport). Insights only *expose* the record; the push belongs there.
  - Any cross-user comparison, sharing, or public profile.

## 4. Domain Model & Ubiquitous Language

- **Record.** A user's all-time best for one **record type** within one **sport**. Immutable in
  meaning, mutable in value: it only ever moves in the "better" direction (higher speed/distance,
  longer duration). Every record carries provenance — the `activityUid` and `achievedAt` of the
  session that set it — so the app can deep-link to it.
- **Record type (`recordTypeEnum`).** The closed set of things we keep an all-time best of. Two
  families: **summary records** (derived from `activity_summary`: `max_speed`, `avg_speed`,
  `session_distance`, `session_duration`, `session_moving_duration`, `max_distance_from_start`)
  and **effort records** (derived from `activity_effort`, one per `effortTypeEnum` value:
  `effort_time_2s` … `effort_best_5x10`). One flat enum keeps the table self-describing and
  point-queryable; the effort mapping is a mechanical `effort_${effortType}` prefix.
- **Period (`activityPeriodEnum`).** `week | month | season | year | custom`. `week`/`month`/
  `year` bucket by `date_trunc`; `season` is a meteorological quarter, hemisphere-aware (§7);
  `custom` is a caller-supplied `[from,to)` range that is **always read-time** (never
  materialized).
- **Period bucket.** The materialized unit of `user_period_stat`: one `(userId, sport, periodType,
  periodStart)` row holding the aggregates for that window. `periodStart` is a **local date**
  (the activity's `timezone`-resolved calendar day the window starts on), so "this week" means
  the user's week, not UTC's.
- **Period summary + delta.** The app's 4-card view (Volume · Duration · Performance · Frequency)
  for the current bucket, each card paired with its change vs the immediately-preceding bucket of
  the same `periodType`. Which four metrics fill the cards is chosen per sport + goal from
  `user_sport_profile.cardSlots` (RFC-0003) — the backend returns the values; the app owns the
  slot layout.
- **Trend.** An ordered series of a single `summaryMetric` across the last *N* buckets of a
  `periodType` — the data behind an insights line/bar chart.
- **Streak.** A run of consecutive active **weeks** (weeks with ≥1 session). `currentStreak` is
  the run ending at the present (or most recent) week; `longestStreak` is the max run ever.
  Computed from the `week` rows of `user_period_stat`.
- **Pattern (evidence-gated insight).** A derived claim that only appears once a threshold of
  comparable data is met — `fastest_conditions` (≥5 sessions, ≥3 distinct days), `fastest_spot`
  (≥2 spots × ≥2 sessions), `fastest_equipment` (≥2 gear × ≥2 sessions). Below threshold the
  pattern is **absent**, never a "not enough data" guess.
- **Maintenance hook vs. recompute.** Two ways a rollup changes: the **hook**
  (`onActivityComputed`) applies one just-finished activity incrementally (O(1), immediate); the
  **recompute** (`recomputeForUser`) rebuilds a user's rollups from the source tables (authoritative,
  idempotent — the truth the hook is an optimization of).

State/flow of a record over its life:

```
session uploaded ──▶ RFC-0006 metric task computes L1 ──▶ status = ready
                                                            │
                                                            ▼ (hook, same task run)
                              InsightsService.onActivityComputed(activityId)
                                 ├─ upsert user_record   (keep if candidate is better)
                                 └─ upsert user_period_stat buckets (add / greatest)
                                                            │
   delete / edit / algo-bump / merge ─────────────────────┘ can only *lower* a max,
                                                            which the hook cannot reverse
                                                            ▼
                          insights-nightly-rollup / recomputeForUser (authoritative rebuild)
```

## 5. Data Model (Drizzle)

Three tables, all insights-owned, all following the house `id` (integer identity PK, internal) +
`uid` (text uuid, public) pattern, jsonb typed `.$type<JsonValue>()`, timestamps `timestamptz`
precision 3, and **canonical SI** stored values (D-006). All new tables/enums/relations land in
`src/db/schema.ts`; types are re-exported from `src/db/index.ts`; a migration is generated with
`npm run db:gen` (never auto-migrated in prod).

### 5.0 The join-path problem (why new tables at all)

RFC-0006 shipped `activity_summary` and `activity_effort` keyed on `activityId` **without**
`userId` or a date column. The only per-user index in that domain is on `activity`:

```
activity_user_started_idx  ON activity (user_id, started_at)   -- drives period range scans
activity_user_sport_idx    ON activity (user_id, sport)        -- drives per-sport filters
activity_effort_activity_type_key  UNIQUE ON activity_effort (activity_id, type)
activity_summary            UNIQUE ON activity_summary (activity_id)
```

So the **source read-time join path** is fixed:

```sql
-- period aggregate (trends / summary): driven by activity_user_started_idx
SELECT date_trunc('week', a.started_at), sum(s.total_distance_m), max(s.max_speed_ms), count(*)
FROM activity a JOIN activity_summary s ON s.activity_id = a.id
WHERE a.user_id = $1 AND a.sport = $2 AND a.started_at >= $3 AND a.started_at < $4
GROUP BY 1;

-- all-time records: driven by activity_user_sport_idx, then hash-join to efforts
SELECT e.type, max(e.result_ms)
FROM activity a JOIN activity_effort e ON e.activity_id = a.id
WHERE a.user_id = $1 AND a.sport = $2
GROUP BY e.type;
```

Two options are then possible (weighed in §14): **denormalize `userId`/date onto the RFC-0006
L1 tables**, or **maintain insights-owned rollups**. This RFC chooses the latter — it does **not
touch the completed, near-immutable L1 tables** (which would also drag the merge path,
[[decisions]] D-008, into rewriting `activity_summary`/`activity_effort` on every reassign) and
instead lets the new rollup tables carry their own denormalized `userId` / `sport` / date. The
join path above becomes the engine of `recomputeForUser` (and a fallback), not the per-request
hot path.

### 5.1 Enums

```typescript
// All-time record keys — a flat, self-describing union of summary-derived and
// effort-derived records (effort_* mirrors effortTypeEnum 1:1).
export const recordTypeEnum = pgEnum("record_type", [
  // summary-derived
  "max_speed",
  "avg_speed",
  "session_distance",          // longest single-session distance
  "session_duration",          // longest time on water
  "session_moving_duration",   // longest moving time
  "max_distance_from_start",   // furthest point reached from launch
  // effort-derived (one per effortTypeEnum value)
  "effort_time_2s", "effort_time_5s", "effort_time_10s", "effort_time_20s",
  "effort_time_30s", "effort_time_1m", "effort_time_5m",
  "effort_dist_100m", "effort_dist_250m", "effort_dist_500m",
  "effort_dist_1km", "effort_dist_nm", "effort_best_5x10",
]);

// Evidence-gated derived insights (payload lives in insight_cache.payload jsonb).
export const insightKeyEnum = pgEnum("insight_key", [
  "fastest_conditions",  // ≥5 sessions, ≥3 distinct days
  "fastest_spot",        // ≥2 spots × ≥2 sessions
  "fastest_equipment",   // ≥2 gear × ≥2 sessions
]);
```

### 5.2 `user_record` — all-time personal bests (materialized)

One row per `(userId, sport, recordType)`. Small and bounded: `#sports × #recordTypes` per user
(≈ 4 × 19). Every write is a conditional upsert that only moves the record in the better
direction.

| Column | Type | Notes / rationale |
| --- | --- | --- |
| `id` | integer identity PK | internal |
| `uid` | text uuid | public id |
| `userId` | integer → `user.id` | **denormalized owner key** (the whole point — indexable per user) |
| `sport` | `sportEnum` | records are per-sport (cross-sport bests are read-time, §7) |
| `recordType` | `recordTypeEnum` | which best this is |
| `value` | real | canonical SI; interpretation implied by `recordType` (m/s for `*_speed`/`effort_*`, m for `*_distance`/`max_distance_from_start`, s for `*_duration`) |
| `activityId` | integer → `activity.id` `onDelete: set null` | which session set it (internal join) |
| `activityUid` | text | public id of that session (returned to the app for deep-linking; survives the FK going null) |
| `achievedAt` | timestamptz | the session's `startedAt` — when the record was set |
| `algorithmVersion` | integer | the L1 `algorithmVersion` this record was derived under; a nightly recompute under a newer version rewrites it |
| `updatedAt` | timestamptz | last time this record moved |

Constraints / indexes:
- `uniqueIndex("user_record_user_sport_type_key") ON (userId, sport, recordType)` — the upsert
  conflict target and the natural key.
- `index("user_record_user_sport_idx") ON (userId, sport)` — serves `GET …/records?sport=`.
- FK `activityId onDelete: set null` (record keeps `activityUid` + `achievedAt` even if the
  session is deleted; the nightly recompute then re-derives the true post-deletion record).

### 5.3 `user_period_stat` — per-user period rollup (materialized)

One row per `(userId, sport, periodType, periodStart)`, for `periodType ∈ {week, month, season,
year}` (never `custom`). Holds the pre-aggregated numbers behind trends, the period summary, and
lifetime totals (summed from the `year` rows) + streaks (from the `week` rows).

| Column | Type | Notes / rationale |
| --- | --- | --- |
| `id` / `uid` | identity / uuid | as usual |
| `userId` | integer → `user.id` | denormalized owner key |
| `sport` | `sportEnum` | per-sport bucket |
| `periodType` | `activityPeriodEnum` | week/month/season/year (a `check` excludes `custom`) |
| `periodStart` | date | **local** calendar start of the bucket (timezone-resolved, §7) |
| `sessionCount` | integer | frequency |
| `activeDays` | integer | distinct local days with a session (frequency card) |
| `totalDistanceM` | real | volume card |
| `totalDurationSec` | real | duration card (time on water) |
| `totalMovingSec` | real | moving time |
| `maxSpeedMs` | real | performance card (period best) |
| `bestEffort5x10Ms` | real nullable | performance card alt (period best of the `best_5x10` effort) |
| `sumForAvgSpeed` | real | Σ(avgMovingSpeed·movingSec) — numerator so a period avg-speed is `sumForAvgSpeed / totalMovingSec` without re-reading sessions |
| `algorithmVersion` | integer | max L1 algo version folded into this bucket (staleness signal for recompute) |
| `computedAt` | timestamptz | last authoritative recompute of this bucket |
| `updatedAt` | timestamptz | last touch (hook or recompute) |

Constraints / indexes:
- `uniqueIndex("user_period_stat_key") ON (userId, sport, periodType, periodStart)` — upsert target.
- `index("user_period_stat_trend_idx") ON (userId, sport, periodType, periodStart)` — a trend is
  `WHERE userId=? AND sport=? AND periodType=? ORDER BY periodStart DESC LIMIT N`, a bounded index
  range scan.

Rationale for the extra sums (`sumForAvgSpeed`, `totalMovingSec`): storing **additive**
quantities (not pre-divided averages) is what makes incremental maintenance correct — you can add
one session's contribution to a bucket without re-reading the others. Non-additive quantities
(maxima) are handled by `greatest()` on the hook and re-derived on recompute (a max cannot be
incrementally *lowered* when a session leaves — see §7).

### 5.4 `insight_cache` — evidence-gated derived insights (materialized, TTL)

The `fastest_*` patterns are join-heavy (effort × condition / spot / equipment) and evidence-gated;
they are refreshed by the nightly cron, not per request. One row per `(userId, sport, insightKey)`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` / `uid` | identity / uuid | |
| `userId` / `sport` | fk / enum | owner + sport scope |
| `insightKey` | `insightKeyEnum` | which pattern |
| `evidenceMet` | boolean | did the sample clear the threshold? if false the endpoint omits it |
| `payload` | jsonb `.$type<JsonValue>()` | the computed insight (e.g. `{ directionBand:"NW", avgPeakMs: 9.1, sampleSessions: 7 }`) |
| `computedAt` | timestamptz | when derived |
| `expiresAt` | timestamptz | TTL; a read past this is treated as a miss and recomputed lazily |

- `uniqueIndex("insight_cache_key") ON (userId, sport, insightKey)`.

### 5.5 Relations, types, migration

- Relations: `user_record.userId` / `user_period_stat.userId` / `insight_cache.userId` →
  `userTable`; `user_record.activityId` → `activityTable`. Registered in `dbSchema`.
- `export type UserRecord = typeof userRecordTable.$inferSelect;` (+ `NewUserRecord`, and the same
  for the other two) in `schema.ts`, re-exported from `src/db/index.ts`.
- Migration via `npm run db:gen`. **Backfill:** for any user with pre-existing activities,
  `insights-nightly-rollup` (§8) does the first authoritative build; the tables start empty and
  fill lazily/nightly, so there is no blocking data migration.

## 6. API Surface (routes + OpenAPI)

All endpoints are user-scoped and mount under `/v1/me/insights` (the "me" namespace, alongside
`/v1/me` profile and `/v1/me/favorites`). Registered in `src/domains/index.ts` via
`app.route("/v1/me/insights", insightsRoute)`.

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| GET | `/v1/me/insights/records` | user | All-time personal records (optionally per sport) |
| GET | `/v1/me/insights/trends` | user | A metric's series across the last N period buckets |
| GET | `/v1/me/insights/summary` | user | Current-period cards + delta vs previous period |
| GET | `/v1/me/insights/profile` | user | Lifetime aggregates + streaks (profile header) |
| GET | `/v1/me/insights/patterns` | user | Evidence-gated fastest conditions/spot/gear *(P1-within-insights)* |

- **Auth:** every route `use("*", authenticate)` — accepts the anonymous JWT and Clerk equally
  (RFC-0002); the principal is `c.var.user`. Anonymous users see **their own** insights (which
  merge into the account on link — §7 merge hook).
- **Envelopes:** success `{ data }` via `HTTPResponse.success(...)`; errors are centrally shaped
  `{ error, reason?, message, statusCode }`. Response schemas carry `.describe()` +
  `.meta({ ref })`.
- **Read rate limit:** `rateLimit({ windowMs: 60_000, max: 120 })` — cheap reads, generous cap,
  present for parity/DoS hygiene.

### 6.1 `GET /v1/me/insights/records`

- **Request (query):**
  ```typescript
  export const recordsQuerySchema = z.object({
    sport: z.enum(sportEnum.enumValues).optional(), // omit → all sports the user has
  });
  ```
- **Response** (`.meta({ ref: "InsightsRecordsResponse" })`):
  ```typescript
  const recordItemSchema = z.object({
    sport: z.enum(sportEnum.enumValues),
    recordType: z.enum(recordTypeEnum.enumValues),
    value: z.number(),               // canonical SI (m/s | m | s per recordType)
    activityUid: z.string().nullable(),
    achievedAt: z.iso.datetime().nullable(),
  });
  export const recordsResponseSchema = z
    .object({ records: z.array(recordItemSchema) })
    .describe("The user's all-time personal records")
    .meta({ ref: "InsightsRecordsResponse" });
  ```
- **Errors:** none domain-specific (an empty history → `{ records: [] }`, not 404).
- **Example:**
  ```jsonc
  // GET /v1/me/insights/records?sport=windsurf
  { "data": { "records": [
    { "sport":"windsurf","recordType":"max_speed","value":16.94,
      "activityUid":"4b1e…","achievedAt":"2026-06-14T13:22:11.000Z" },
    { "sport":"windsurf","recordType":"effort_best_5x10","value":14.02,
      "activityUid":"4b1e…","achievedAt":"2026-06-14T13:22:11.000Z" },
    { "sport":"windsurf","recordType":"session_distance","value":38240.5,
      "activityUid":"9c02…","achievedAt":"2026-05-30T09:10:00.000Z" }
  ] } }
  ```

### 6.2 `GET /v1/me/insights/trends`

- **Request (query):**
  ```typescript
  export const trendsQuerySchema = z.object({
    sport: z.enum(sportEnum.enumValues).optional(),
    period: z.enum(["week", "month", "season", "year"]).default("month"),
    metric: z.enum(summaryMetricEnum.enumValues).default("distance"),
    limit: z.coerce.number().int().positive().max(52).default(12), // last N buckets
  });
  ```
  When `sport` is omitted, only **universal** metrics are allowed (`distance`, `time_on_water`,
  `moving_time`, `sessions`, `active_days`); a sport-specific `metric` (e.g. `best_5x10`,
  `max_speed`, `avg_pace`) without a `sport` → `FORM_ERROR` (`InsightsReason.SPORT_REQUIRED`).
- **Response** (`ref: "InsightsTrendsResponse"`):
  ```typescript
  const trendPointSchema = z.object({
    periodStart: z.string(),          // ISO date (local bucket start)
    value: z.number().nullable(),     // null = an empty bucket in the range
  });
  export const trendsResponseSchema = z
    .object({
      metric: z.enum(summaryMetricEnum.enumValues),
      period: z.enum(activityPeriodEnum.enumValues),
      unit: z.enum(["ms", "m", "sec", "count", "days"]), // canonical unit of `value`
      points: z.array(trendPointSchema),                 // oldest → newest
    })
    .describe("A metric's trend across recent periods")
    .meta({ ref: "InsightsTrendsResponse" });
  ```
- **Example:**
  ```jsonc
  // GET /v1/me/insights/trends?sport=windsurf&period=month&metric=distance&limit=4
  { "data": { "metric":"distance","period":"month","unit":"m","points":[
    { "periodStart":"2026-03-01","value":112430.0 },
    { "periodStart":"2026-04-01","value":null },
    { "periodStart":"2026-05-01","value":98120.5 },
    { "periodStart":"2026-06-01","value":141002.2 }
  ] } }
  ```

### 6.3 `GET /v1/me/insights/summary`

The "profile-stats summary" — the 4 cards + delta. Card **selection** is the user's sport+goal
slots (RFC-0003 `user_sport_profile.cardSlots`); the backend returns each requested metric's
current value and its delta vs the previous same-length period.

- **Request (query):**
  ```typescript
  export const summaryQuerySchema = z.object({
    sport: z.enum(sportEnum.enumValues).optional(),
    period: z.enum(["week", "month", "season", "year"]).default("week"),
  });
  ```
- **Response** (`ref: "InsightsSummaryResponse"`):
  ```typescript
  const summaryCardSchema = z.object({
    metric: z.enum(summaryMetricEnum.enumValues),
    unit: z.enum(["ms", "m", "sec", "count", "days"]),
    value: z.number(),
    previousValue: z.number().nullable(),
    deltaPct: z.number().nullable(),   // null when previous is 0/absent
  });
  export const summaryResponseSchema = z
    .object({
      period: z.enum(activityPeriodEnum.enumValues),
      periodStart: z.string(),         // current bucket (ISO date)
      cards: z.array(summaryCardSchema),
    })
    .describe("Current-period summary cards with deltas vs the previous period")
    .meta({ ref: "InsightsSummaryResponse" });
  ```
- **Example:**
  ```jsonc
  // GET /v1/me/insights/summary?sport=windsurf&period=week
  { "data": { "period":"week","periodStart":"2026-07-06","cards":[
    { "metric":"distance","unit":"m","value":42310.0,"previousValue":31005.0,"deltaPct":36.5 },
    { "metric":"time_on_water","unit":"sec","value":9840,"previousValue":8100,"deltaPct":21.5 },
    { "metric":"best_5x10","unit":"ms","value":14.02,"previousValue":13.7,"deltaPct":2.3 },
    { "metric":"sessions","unit":"count","value":3,"previousValue":2,"deltaPct":50.0 }
  ] } }
  ```

### 6.4 `GET /v1/me/insights/profile`

- **Request (query):** `{ sport?: sportEnum }`.
- **Response** (`ref: "InsightsProfileResponse"`): lifetime totals (summed from `year` buckets)
  + streaks (from `week` buckets) + a small `topRecords` preview.
  ```typescript
  export const profileResponseSchema = z
    .object({
      lifetime: z.object({
        sessions: z.number(),
        activeDays: z.number(),
        totalDistanceM: z.number(),
        totalDurationSec: z.number(),
        firstSessionAt: z.iso.datetime().nullable(),
      }),
      streak: z.object({
        currentWeeks: z.number(),
        longestWeeks: z.number(),
      }),
      topRecords: z.array(recordItemSchema), // e.g. max_speed + best_5x10 + session_distance
    })
    .describe("Lifetime aggregates and streaks for the profile header")
    .meta({ ref: "InsightsProfileResponse" });
  ```

### 6.5 `GET /v1/me/insights/patterns` *(P1-within-insights)*

- **Request:** `{ sport?: sportEnum }`.
- **Response** (`ref: "InsightsPatternsResponse"`): an array of the `fastest_*` insights whose
  `evidenceMet` is true; below threshold the pattern is **omitted** entirely (never a placeholder).
  ```typescript
  const patternSchema = z.object({
    insightKey: z.enum(insightKeyEnum.enumValues),
    payload: z.record(z.string(), z.unknown()), // shape per key (see insight_cache)
  });
  export const patternsResponseSchema = z
    .object({ patterns: z.array(patternSchema) })
    .describe("Evidence-gated derived insights (only those with sufficient data)")
    .meta({ ref: "InsightsPatternsResponse" });
  ```

## 7. Services & Business Logic

`InsightsService extends BaseUseCase` (no `dbClient`; only `this.config`); `InsightsRepository
extends BaseRepository` (owns the Drizzle operators + `*Table` refs, including all `sql`
aggregation). Constructors are pure (no DB/config work at build time — the container invariant,
RFC-0001 §6).

```typescript
export class InsightsService extends BaseUseCase {
  constructor(private readonly insightsRepository: InsightsRepository) { super(); }

  // ── reads (route-facing) ───────────────────────────────────────────────────
  getRecords(user: RequestUser, q: { sport?: Sport }): Promise<RecordsDto>;
  getTrends(user: RequestUser, q: TrendsQuery): Promise<TrendsDto>;
  getSummary(user: RequestUser, q: SummaryQuery): Promise<SummaryDto>;
  getProfile(user: RequestUser, q: { sport?: Sport }): Promise<ProfileDto>;
  getPatterns(user: RequestUser, q: { sport?: Sport }): Promise<PatternsDto>;

  // ── maintenance (port-facing, called by RFC-0006's metric task) ────────────
  onActivityComputed(activityId: number): Promise<void>;   // hook, O(1) incremental
  recomputeForUser(userId: number): Promise<void>;         // authoritative rebuild
}
```

### 7.1 The maintenance hook — `onActivityComputed(activityId)`

Invoked at the tail of RFC-0006's `activity-compute-metrics` task, **after** `status=ready` is
written, via an explicit cross-domain port (§9). Steps:

1. Load the activity's `userId`, `sport`, `startedAt`, `timezone`, `spotUid`, its
   `activity_summary`, and its `activity_effort` rows (a single repository call).
2. **Records.** For each candidate record (6 summary + up to 13 effort values), issue a
   **conditional upsert** into `user_record`:
   ```sql
   INSERT INTO user_record (uid, user_id, sport, record_type, value, activity_id,
                            activity_uid, achieved_at, algorithm_version, updated_at)
   VALUES (…)
   ON CONFLICT (user_id, sport, record_type) DO UPDATE
     SET value = EXCLUDED.value, activity_id = EXCLUDED.activity_id,
         activity_uid = EXCLUDED.activity_uid, achieved_at = EXCLUDED.achieved_at,
         algorithm_version = EXCLUDED.algorithm_version, updated_at = now()
     WHERE EXCLUDED.value > user_record.value;   -- only move in the better direction
   ```
   The `WHERE` on the update makes a re-run harmless: re-processing the same session (recompute,
   double enqueue) never demotes a record.
3. **Period buckets.** Resolve the four bucket keys the session's **local** date falls in
   (`week`/`month`/`season`/`year`, §7.4), and for each, upsert additive contributions and
   `greatest()` maxima:
   ```sql
   ON CONFLICT (user_id, sport, period_type, period_start) DO UPDATE SET
     session_count      = user_period_stat.session_count + 1,
     total_distance_m   = user_period_stat.total_distance_m + EXCLUDED.total_distance_m,
     total_duration_sec = user_period_stat.total_duration_sec + EXCLUDED.total_duration_sec,
     total_moving_sec   = user_period_stat.total_moving_sec + EXCLUDED.total_moving_sec,
     sum_for_avg_speed  = user_period_stat.sum_for_avg_speed + EXCLUDED.sum_for_avg_speed,
     max_speed_ms       = greatest(user_period_stat.max_speed_ms, EXCLUDED.max_speed_ms),
     best_effort_5x10_ms= greatest(coalesce(user_period_stat.best_effort_5x10_ms,0), …),
     updated_at         = now();
   -- active_days is NOT trivially incremental (dedup by day) → recomputed nightly (§7.3)
   ```
   `activeDays` is intentionally **not** maintained by the hook (it needs day-level dedup across
   the bucket's sessions); the hook sets it to `max(existing, 1)` and the nightly recompute makes
   it exact. This is the one deliberately-approximate field between recomputes (§11 flags it).

**Idempotency & concurrency.** The hook is safe to call more than once for the same activity: the
record upsert is guarded by `>`, and the bucket increments are the drift the nightly recompute
reconciles. To keep the *common* path exact, the hook records the activity's `id` in a processed
set (a `insights_processed` marker column on `activity_summary` is avoidable — instead the hook
keys off `activity_summary.algorithmVersion` vs `user_period_stat.algorithmVersion` so a
re-processed-at-same-version session is skipped). Where exactness matters more than latency (e.g.
a burst of concurrent uploads), operators can lean on the nightly rebuild.

### 7.2 Reads

- **`getRecords`** — a single `SELECT … WHERE userId=? [AND sport=?]` on `user_record` (index
  `user_record_user_sport_idx`), mapped to DTOs. When `sport` is omitted, **universal** records
  (`session_distance`, `session_duration`, `max_speed`) may additionally be folded to a
  cross-sport "best of any sport" row at read time (max over the per-sport rows); sport-specific
  effort records stay per-sport.
- **`getTrends`** — read the last `limit` `user_period_stat` rows for `(userId, sport, periodType)`
  ordered by `periodStart DESC`, then **densify**: fill gaps between the oldest and newest returned
  buckets with `value:null` so the chart shows empty weeks/months. The metric→column projection is
  a static map (`distance→totalDistanceM`, `max_speed→maxSpeedMs`, `avg_speed→sumForAvgSpeed/
  totalMovingSec`, `sessions→sessionCount`, `active_days→activeDays`, `best_5x10→bestEffort5x10Ms`,
  `avg_pace→totalMovingSec/totalDistanceM`). `custom`/multi-sport universal aggregation falls back
  to the read-time source join (§5.0).
- **`getSummary`** — fetch the current bucket and the immediately-preceding bucket of the same
  `periodType`; for each of the sport+goal card metrics compute `value`, `previousValue`,
  `deltaPct = previous>0 ? (value-previous)/previous*100 : null`. Card *selection* comes from the
  user's `user_sport_profile.cardSlots` (RFC-0003) — if the user has no profile for the sport, a
  sport-default slot list (from `sport_definition`) is used; multi-sport (no `sport`) uses the
  universal quartet `distance / time_on_water / sessions / active_days` ([[metrics-catalog]] §C note).
- **`getProfile`** — lifetime totals = `SUM` over the user's `year` buckets (a handful of rows);
  `firstSessionAt` = min `achievedAt`/earliest bucket; streaks from the `week` rows (§7.5).
- **`getPatterns`** — read `insight_cache` rows for `(userId, sport)` with `evidenceMet=true` and
  `expiresAt>now`; a miss/expired entry triggers a lazy recompute of that pattern (bounded, from
  the source join) and a cache write.

### 7.3 The authoritative recompute — `recomputeForUser(userId)`

Rebuilds all three rollups for one user **from the source tables**, in one transaction per rollup
family, idempotently:

1. `DELETE FROM user_period_stat WHERE user_id=?` then re-`INSERT … SELECT` the grouped aggregate
   (the §5.0 period query, `GROUP BY sport, periodType, periodStart`, all four period types in one
   pass using `GROUPING SETS` / four unioned selects). `activeDays` here is exact
   (`count(DISTINCT local_date)`).
2. Recompute `user_record` via the `MAX(...) GROUP BY recordType` join (both summary and effort
   families) with an `arg_max`-style lateral to fetch the setting session's `activityUid`/`achievedAt`.
3. Refresh `insight_cache` (the `fastest_*` patterns) with fresh evidence checks.

This is the truth the hook approximates. It runs: nightly (§8), on an algorithm-version bump
(records/buckets under the old `algorithmVersion` are stale), and after an account merge (§7.6).
Being a delete-and-rebuild, it is safe to re-run at any time.

### 7.4 Period bucketing (local, hemisphere-aware seasons)

- `week`: ISO week, Monday start, of the session's **local** date. `month`/`year`:
  `date_trunc` of the local date. Local date = `startedAt` shifted into `activity.timezone` (when
  present; else UTC — flagged in §16 as the known coarse case for users without a device timezone).
- `season`: meteorological quarter of the local month — DJF / MAM / JJA / SON — **flipped for the
  southern hemisphere** (derived from the session's `startLat`; ≥0 → north). `periodStart` is the
  first day of the season. A session on the hemisphere boundary (unknown lat) defaults to north.
- Bucketing happens in the repository (`sql` `date_trunc` + a small season CASE); the service only
  passes `periodType`.

### 7.5 Streaks

From the user's `week` rows ordered by `periodStart`: `longestWeeks` = the longest run of
consecutive weeks each with `sessionCount>0`; `currentWeeks` = the run ending at the current ISO
week, or 0 if the current (and, with a one-week grace, the previous) week is empty. Computed in
the service from the already-fetched week series — no extra query.

### 7.6 Cross-domain flows

- **Merge (D-008).** Insights exposes a `MergeReassigner`: on anonymous→Clerk merge it
  `DELETE`s the *source* user's `user_record` / `user_period_stat` / `insight_cache` rows inside
  the merge transaction (the source user's activities are moved to the target by RFC-0006's
  `activityReassigner`, which runs in the same tx), then enqueues `insights-recompute-user(toUserId)`
  so the target's rollups are rebuilt over the merged history. Ordering: the insights reassigner
  must run **after** the activity reassigner (both are in `mergeReassigners`, applied in array
  order — §9).
- **Delete.** An activity delete cascades to its L1 rows (RFC-0006 `onDelete: cascade`) and nulls
  the `user_record.activityId` FK; the record's *value* is corrected by the next nightly
  recompute. A "new best just got deleted" is thus eventually consistent (acceptable — records are
  not transactional truth, and the window is one night; §11).

## 8. Background Jobs (Trigger.dev)

Two tasks under `src/domains/feature/insights/tasks/`, both following the RFC-0001 lifecycle
(`initializeForTrigger()` + `createDBManagerForTrigger()` + `buildContainer(db)` in `try`,
`finalizeTrigger(dbManager)` in `finally`), invoked from services/other tasks, never routes.

- **`insights-nightly-rollup`** — a `schedules.task` (cron, no payload), e.g. `cron: "0 3 * * *"`,
  `maxDuration: 300`, `retry: { maxAttempts: 3 }`, `queue: { concurrencyLimit: 1 }`. It selects
  users with any activity `updatedAt`/`computedAt` since the last run (plus a slow full sweep,
  e.g. all users once a week), and calls `recomputeForUser(userId)` for each. This is the
  authoritative reconciler for hook drift (bucket increment skew, `activeDays` exactness),
  post-deletion record correction, and `insight_cache` refresh. Idempotent by construction.
- **`insights-recompute-user`** — a `schemaTask` (`payload: { userId: number }`),
  `queue: { concurrencyLimit: 4 }`, calls `recomputeForUser`. Triggered on-demand by (a) the merge
  hook (rebuild the target), and (b) an algorithm-version bump rollout (fan-out over affected
  users). Same idempotent body as the nightly path.

The **hook** (`onActivityComputed`) is *not* a task — it is an inline port call from the existing
`activity-compute-metrics` task run, so a freshly processed session's records/summary are visible
the instant the activity turns `ready` (no extra scheduling latency).

## 9. Dependencies & Integrations

- **RFC-0006 (activity) — the source and the one required edit outside this domain.** Insights
  reads `activity`, `activity_summary`, `activity_effort` (and `activity_condition` /
  `activity_equipment` for patterns). It also **adds a seam** to RFC-0006's already-shipped code:
  the `activity-compute-metrics` task must, after writing L1, call an injected
  `insightsMaintenancePort.onActivityComputed(activityId)`, and `createActivityModule` must accept
  that port. Wiring in `src/container.ts` mirrors the existing explicit cross-domain pattern
  (weather→spot):
  ```typescript
  const insights = createInsightsModule(deps);
  const { activityReassigner, ...activityServices } = createActivityModule({
    ...deps,
    insightsMaintenancePort: insights.insightsService, // narrow port: { onActivityComputed }
  });
  const auth = createAuthModule({
    ...deps,
    // order matters: activity moves rows first, insights rebuilds target after
    mergeReassigners: [favoriteReassigner, activityReassigner, insights.insightsReassigner],
  });
  ```
  `feature/insights → feature/activity` (reading its tables/types) is an allowed `feature→feature`
  edge; `activity → insights` is expressed only as a **narrow port type** (`{ onActivityComputed }`),
  not a concrete import, keeping the dependency inversion clean.
- **RFC-0003 (user profile).** `getSummary` reads `user_sport_profile.cardSlots` /
  `analyticsFocus` (RFC-0003) to pick the four cards; a missing profile falls back to
  `sport_definition` defaults.
- **RFC-0004 (spot).** `fastest_spot` uses `activity.spotUid` / `spotName`.
- **No external services.** No Open-Meteo, S3, Clerk, or RevenueCat calls. Config: an optional
  `INSIGHTS_*` block for evidence thresholds and the nightly cadence (defaults inline), read via
  `this.config`.
- **Exposed for later RFCs:** `InsightsService` read methods (profile screen), and a future
  "record broken" event that RFC-0009 notifications could subscribe to (out of scope here).

## 10. Security & Privacy

- **User-scoping is total.** Every read filters by `c.var.user.id`; every rollup row carries
  `userId` and is only ever queried for the owning user. There is no path to another user's
  insights — the `uid`s returned are the user's own activity uids.
- **No new sensitive data.** Insights store only *aggregates* of the user's own sessions; the raw
  track and precise start-point privacy (RFC-0006 `privacy`/`hideStart`) are not re-exposed here
  (records deep-link by `activityUid`, and the activity detail endpoint enforces its own
  visibility). Because insights are strictly self-view, activity `privacy` does not gate them.
- **Anonymous users** get their own insights; on account link the merge hook (§7.6) rebuilds them
  under the Clerk identity and drops the retired anonymous rows in the same transaction — no
  orphaned insight leaks to the merged-away user.
- **Input hardening.** All query params are Zod-validated (enums, `limit` capped at 52); no
  free-form input reaches a query. Aggregation SQL lives only in the repository (grep guard,
  [[../otonom-kararlar]] §12).
- **Errors:** `UNAUTHENTICATED`(401) via `authenticate`; `FORM_ERROR`(422? no — 400/422 per the
  error map) for a sport-specific metric without a sport (`InsightsReason.SPORT_REQUIRED`). No
  `ALREADY_EXISTS` surface here.

## 11. Observability

- **Logging** (`createLogger("InsightsService")` / `"insights-nightly-rollup"`): the hook logs at
  `debug` (activityId, records moved, buckets touched); `recomputeForUser` logs at `info`
  (userId, rows rebuilt, duration); the nightly cron logs a run summary (users processed, total
  rows, elapsed) — mirroring `weather-refresh`'s return-value log.
- **Reported as exceptions:** unhandled failures inside the two tasks (`Tracking.captureException`
  with `{ taskId }`), since a broken rollup is a data-integrity bug. Expected read-path
  `GenericError`s are returned, not reported (RFC-0001 policy).
- **Known-approximate signal.** Between recomputes, `activeDays` (and any bucket max after a
  delete) can drift from source truth; the nightly run's summary log surfaces the reconciliation
  delta so drift is visible, not silent. A large delta is a signal the hook missed events.
- **Metrics worth surfacing:** rollup rows per user (table growth), nightly recompute duration
  (scales with active-user count), and `insight_cache` hit/miss on `getPatterns`.

## 12. Performance & Scalability

- **Hot path is O(1) in history.** `getRecords` / `getSummary` / `getProfile` read a bounded
  number of pre-aggregated rows (records ≈ sports×19; period buckets = a few per period type).
  `getTrends` is a bounded index range scan (`≤ limit` rows). None scans the user's full session
  history — which is the whole reason for materializing (a read-time records query would be a full
  per-user effort scan with no supporting index, growing linearly with sessions; see §14).
- **Write amplification is small and bounded.** The hook does ≤19 record upserts + 4 bucket
  upserts per processed activity — a constant, independent of history size, on the already-running
  metric task.
- **Index cost.** Three small tables, one unique index + one lookup index each. `user_record` and
  `user_period_stat` grow linearly with *distinct sports × active periods*, not with sessions, so
  they stay tiny (a 5-year daily rider has ~260 week rows/sport). The source read-time path
  (recompute/backfill) leans on the existing `activity_user_started_idx` /
  `activity_user_sport_idx`; no new index on the RFC-0006 tables is required.
- **Nightly cost scales with active users, not total sessions** (it recomputes only recently-active
  users incrementally, with a slow full sweep). `concurrencyLimit:1` keeps it off the HTTP pool.
- **Deferred until it hurts:** partitioning `user_period_stat`, a `LISTEN/NOTIFY` push instead of a
  nightly sweep, and denormalizing onto the L1 tables (§14) are all explicitly *not* done now.

## 13. Testing Strategy

Co-located `insights.service.spec.ts` (all repository/port deps mocked; happy + error + edge):

- **Records:** a candidate that beats the stored record updates it; one that ties/loses does not
  (the `>` guard); re-processing the same session is a no-op (idempotent hook).
- **Period bucketing:** a session's local date lands in the correct week/month/season/year buckets;
  a southern-hemisphere session flips the season; a timezone-less session falls back to UTC.
- **Summary + delta:** current vs previous bucket delta math; `previousValue=0` → `deltaPct=null`;
  card selection follows `user_sport_profile.cardSlots`, falls back to sport defaults, and uses the
  universal quartet when `sport` is omitted.
- **Trends:** densification inserts `null` for empty buckets; a sport-specific metric without a
  sport → `SPORT_REQUIRED`; the metric→column projection (incl. derived avg-speed/pace) is correct.
- **Streaks:** consecutive-week run detection; current-streak grace window; empty history → 0.
- **Evidence gating:** below threshold → pattern omitted; at/above → present.
- **Recompute == hook (property):** a series of sessions applied via the hook yields the same
  rollups as `recomputeForUser` over the same set (the reconciliation invariant), including exact
  `activeDays` after recompute.
- **Merge reassigner:** source rows deleted, target recompute enqueued; ordering after the activity
  reassigner.
- **Manual/integration before ship:** run the migration on a seeded multi-session user; hit all
  four read endpoints; confirm the RFC-0006 task seam fires the hook (records appear the moment an
  upload turns `ready`).

## 14. Alternatives Considered

- **Pure read-time aggregation, no rollup tables (the D-005 baseline).** Simplest and always
  correct: per-session metrics are already on the row, so trends/summary are just
  `GROUP BY date_trunc`. **Rejected as the sole approach** for two reasons rooted in the *actual*
  RFC-0006 schema: (a) `activity_summary`/`activity_effort` have no `userId`/date, so every query
  joins back to `activity` (tolerable), and (b) **records** have no per-user index — "best ever"
  is a full scan of the user's efforts that grows with every session and sits on the hottest
  screen (the profile). We keep read-time as the recompute/backfill engine and fallback, but not
  the request path.
- **Denormalize `userId` + local-date onto `activity_summary` / `activity_effort`, then partial
  indexes.** Enables per-user record/period indexes without new tables. **Rejected:** it edits
  completed, effectively-immutable L1 tables; it forces the D-008 merge path and the metric
  recompute to also rewrite those columns on every activity move; and even with the column a
  records query is still a `MAX` scan unless we add covering indexes on the L1 tables (index bloat
  on the largest tables in the system). Materializing small purpose-built rollups is cheaper and
  keeps RFC-0006 untouched.
- **Materialized rollups, chosen (hybrid).** `user_record` + `user_period_stat` maintained by an
  incremental hook and reconciled nightly; `insight_cache` for join-heavy patterns. O(1) reads,
  immediate record updates, correctness restored nightly. Cost: maintenance code + eventual
  consistency after deletes — bounded to one night and reconciled authoritatively. This is the
  standard "fast incremental path + authoritative rebuild" shape and it aligns with D-005's intent
  (schema shaped by the period query) while fixing the record hot-spot D-005 didn't foresee.
- **Postgres materialized views (`REFRESH MATERIALIZED VIEW`).** Rejected: refresh is *global*
  (whole view), not per-user incremental — it would recompute every user nightly regardless of
  activity, and can't be updated by the per-activity hook.
- **Redis / precomputed cache only.** Rejected: no Redis in the stack (D-002 / [[../otonom-kararlar]]
  §2); a durable Postgres rollup is the correct primitive here anyway.

## 15. Implementation Plan (checklist)

Ordered per the CLAUDE.md "Adding a New Domain" checklist:

1. **Schema** (`src/db/schema.ts`): `recordTypeEnum`, `insightKeyEnum`; `userRecordTable`,
   `userPeriodStatTable`, `insightCacheTable` (id+uid, indexes, FKs, relations); add to `dbSchema`;
   `export type UserRecord/UserPeriodStat/InsightCache` (+ `New*`). Re-export from `src/db/index.ts`.
2. `npm run db:gen` → migration; notify (no auto-migrate).
3. **`domains/feature/insights/errors.ts`** — `InsightsReason` (`SPORT_REQUIRED`).
4. **`schemas/index.ts`** — request (records/trends/summary/profile/patterns) + response schemas
   (`.describe()` + `.meta({ ref })`).
5. **`repositories/insights.repository.ts`** (`extends BaseRepository`) — record/bucket/cache
   upserts + reads; the source-join aggregation (`recomputeForUser` engine) with `date_trunc` +
   season CASE; `reassignOwner`/delete-for-user.
6. **`services/insights.service.ts`** (`extends BaseUseCase`) — reads + `onActivityComputed` +
   `recomputeForUser`; **`insights.service.spec.ts`** (§13).
7. **`tasks/`** — `insights-nightly-rollup` (schedules.task), `insights-recompute-user`
   (schema/task/trigger).
8. **`routes/v1.ts`** — `insightsRoute` (5 routes: `describeRoute` + `authenticate` + `rateLimit`
   + `zValidator` → module service).
9. **`insights.module.ts`** — `createInsightsModule(deps)` returning `{ insightsService,
   insightsReassigner }`.
10. **`src/container.ts`** — build `insights`, thread `insightsService` as the port into
    `createActivityModule`, append `insights.insightsReassigner` to `mergeReassigners`.
11. **RFC-0006 seam edit** — `activity-compute-metrics` task calls
    `insightsMaintenancePort.onActivityComputed(activityId)` after `status=ready`;
    `createActivityModule` accepts the port. Update RFC-0006 + [[../otonom-kararlar]] to record the seam.
12. **`src/domains/index.ts`** — `app.route("/v1/me/insights", insightsRoute)`.
13. `npm run lint:biome:fix && lint:type && lint:imports && test`; then `convention-reviewer`.

## 16. Open Questions & Resolved Decisions

- **Deferred (resolved).** Not implemented until the 0001–0006 build lands (Berkay 2026-07-11,
  [[../otonom-kararlar]] §0). Meta = `🟡 Draft`; flip to `🚧 In Progress` when the phase opens. ⏸️
- **Final metric/insight set — pending Berkay.** The exact record types, trend metrics, and which
  patterns ship in V1 come from `AnalyticsModels.swift` (`Insights` / `SummaryMetric` /
  `ActivityPeriod`) once Berkay confirms from the app. The design is metric-set-agnostic (enums +
  a metric→column map), so the final list is data, not structure. ❓
- **Which trends the app actually renders** (period × metric matrix, chart types) — TBD from the
  app; `getTrends` already covers the general case. ❓
- **Read-time vs. materialized — resolved** → hybrid (materialized `user_record`/`user_period_stat`
  + read-time recompute engine + `insight_cache`), see §14. Extends D-005 (which established the
  read-time period-query path) by materializing the record hot-spot. ✅
- **Do NOT denormalize the RFC-0006 L1 tables — resolved** → new insights-owned rollups carry
  their own `userId`/date; RFC-0006 stays untouched except the one maintenance-hook seam (§9). ✅
- **Season definition** → meteorological quarter, hemisphere-aware from `startLat`; local-date
  bucketing from `activity.timezone` with a UTC fallback for timezone-less sessions (a known coarse
  case — revisit if it bites). ⏸️
- **Card selection source** → `user_sport_profile.cardSlots` (RFC-0003), sport-default fallback,
  universal quartet for multi-sport. ✅
- **"New personal best" push** → out of scope; a future notification hook for RFC-0008/0009. ⏸️

## 17. References

[[metrics-catalog]] §C (insights family) · [[activity-data-model]] §1 (`activity_summary` /
`activity_effort`) · [[rfc/0006-activity]] · [[rfc/0003-user-profile]] (`user_sport_profile`,
`summaryMetricEnum`) · [[rfc/0001-foundation]] §6–7 (DI, base classes, task lifecycle) ·
[[decisions]] D-001 (canonical compute), D-005 (schema per period query), D-006 (SI units), D-008
(merge reassign) · [[../otonom-kararlar]] §0 (deferral), §12 (DB-access guard) ·
[[architecture]] · app `AnalyticsModels.swift` (`Insights` / `SummaryMetric` / `ActivityPeriod`)
