# RFC-0005: Weather & Conditions Decision Engine

|                |                                        |
| -------------- | -------------------------------------- |
| **RFC**        | 0005                                   |
| **Title**      | Weather & Conditions Decision Engine   |
| **Status**     | ✅ Completed                            |
| **Step**       | 4                                      |
| **Depends on** | RFC-0004 (spot)                        |
| **Domain(s)**  | feature/weather                        |
| **Updated**    | 2026-07-11                             |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

---

## 1. Summary

This RFC turns a spot's coordinates into an actionable verdict. It adds the `feature/weather`
bounded context: a client for **Open-Meteo** (forecast + marine + model-metadata, pinned to a
single model, in canonical SI), a **demand-driven cache** with per-kind TTL and stale-serve
fallback, a **pure decision engine** that maps wind/gust/direction/CAPE/weather-code against
research-backed per-sport wind bands to a `go` / `watch` / `skip` verdict, and two endpoints —
`GET /v1/spots/:uid/conditions` (now-cast + verdict + best window) and
`GET /v1/spots/:uid/forecast` (hourly + daily strip). A Trigger.dev cron re-fetches only the
**hot set** (favorited spots) on a cadence; a second cron refreshes global model-run metadata
for the "updated Xm ago / stale" story.

The single most important design choice is the **`WeatherProvider` interface** (DIP seam):
`WeatherService` depends on an abstract provider that returns canonical-SI payloads, not on
`OpenMeteoClient`. This isolates the one real product gap — Open-Meteo serves a *model
nowcast*, not live station observation — behind a narrow contract so a second source
(METAR/buoy) can be slotted in later without touching the service or the decision engine. The
decision engine itself is a **pure module** (`decision.ts`): no I/O, no config, only
number-in/verdict-out, so its safety logic is exhaustively unit-testable.

## 2. Motivation & Context

- **Problem.** The iOS app ([[../SPLASH-OVERVIEW]]) ships a mock forecast and a hard-coded
  verdict. The whole product promise — "should I go out, and when?" — needs a real weather
  source and a real decision engine keyed on each spot's coordinates and shore orientation.
  Naively refreshing weather for every spot in the database would burn API calls and compute
  on data nobody is looking at.
- **Background.** Field-to-endpoint mapping was verified against the Open-Meteo docs and is
  recorded in [[../weather-openmeteo-mapping]]; the single-provider + demand-driven-cache
  decision is [[decisions]] D-004; canonical-SI storage is D-006; plain-Postgres geo (no
  PostGIS) is D-003. Per-sport wind bands, the freshness model, and the CAPE/offshore safety
  downgrades are recorded in [[../otonom-kararlar]] §24–27. This RFC builds directly on the
  spot domain (RFC-0004): it reads a spot's geo + shore bearing and its favorites feed the hot
  set.
- **Goals.**
  - One Open-Meteo forecast call covers both the sky layer (weather_code, cloud_cover) and the
    decision layer (wind/gust/direction/temp/precip/CAPE); one marine call covers the sea
    layer; one model-metadata call backs freshness.
  - Store canonical SI (m/s, m, °C, UTC) so any client converts for display (D-006).
  - A per-sport, per-hour verdict with go/watch/skip, a confidence label, a "best window", and
    a shore-relative wind side — all derived from a **pure**, fully-tested engine.
  - A spot-scoped cache that fetches on first request, serves stale on provider failure, and is
    warmed for the hot set by a cron — never a global refresh.
  - A provider seam so a live-observation source can be added later without a rewrite.
- **Non-goals.**
  - **Live station observation.** Open-Meteo's `current` block is a model nowcast, not a
    measured observation ([[../weather-openmeteo-mapping]] §3). The MVP labels it honestly and
    makes no station-confidence claim; a real observation source (METAR/buoy) is a later phase.
  - **Drawing the wind-vector grid.** The map's `WindField`/`WeatherSky` rendering is
    client-side; the backend would only ever serve grid *data*, and even that endpoint is
    deferred to P1 (§3, §16).
  - **Per-skill-level wind bands.** Threading the user's `experience` into the verdict is a
    documented fast-follow (§16); this RFC ships a single intermediate-level band table.
  - Alarms/notifications (RFC-0008) — they will *consume* this engine, not live here.

## 3. Scope (In / Out)

- **In:** the `feature/weather` domain — `weather_cache` + `weather_model_meta` tables; the
  `packages/open-meteo` `WeatherProvider` interface + `OpenMeteoClient`; the pure `decision.ts`
  engine (per-sport thresholds, go/watch/skip, confidence, best-window, safety downgrades);
  `WeatherService` (cache-or-fetch, stale-serve, freshness, orchestration) behind the
  `WeatherSpotPort`; `WeatherRepository`; the `conditions` + `forecast` endpoints; the
  `weather-refresh` and `weather-model-meta-refresh` crons; the module + container wiring.
- **Out:**
  - `GET /v1/spots/:uid/wind-field?bbox=` — the wind-vector grid → **P1** (client draws;
    [[../otonom-kararlar]] §27).
  - Live station observation → later phase (separate integration, same `WeatherProvider` seam).
  - Alarm evaluation on top of the verdict → **RFC-0008**.
  - Surfacing marine detail (tide/wave/apparent-temp) and visibility/UV in the response, and
    Zod-validating the raw Open-Meteo body → fast-follows (§16).

## 4. Domain Model & Ubiquitous Language

- **Conditions.** The now-cast slice for a spot: the current wind/gust/direction/temp/weather
  code, the derived **verdict**, **confidence**, **best window**, the sea summary, and
  **freshness**. Served by `GET …/conditions`.
- **Forecast.** The forward-looking strip: an **hourly** series (next 48h, each with its own
  verdict) plus a **daily** roll-up (up to 11 UTC days, each carrying the day's best-hour
  verdict and peak wind). Served by `GET …/forecast`.
- **Verdict / Decision.** One of `go` (ideal), `watch` (marginal or cautioned), `skip`
  (unsuitable or unsafe) for a single hour and a single sport. The engine's output type is
  `Decision = "go" | "watch" | "skip"`.
- **Confidence.** `low | high | medium` qualifying the verdict: `low` whenever data is stale;
  otherwise `medium` for gusty/rainy conditions, `high` when steady and fresh.
- **Wind band / Threshold.** Per-sport `{ minMs, idealMinMs, idealMaxMs, maxMs }` in canonical
  m/s. Below `minMs` is too light; the `[idealMinMs, idealMaxMs]` band is `go`; above `maxMs`
  is too strong. SUP/kayak **invert** this (flat water is best → `idealMinMs = 0`).
- **Wind side.** The wind's orientation relative to the shore, derived from the spot's
  `shoreBearingDeg` (outward normal, shore → open water) and the meteorological wind-from
  direction: `onshore | cross-onshore | cross-shore | cross-offshore | offshore`. **Offshore**
  blows a rider out to sea — the life-safety case. Computed by `windSide()` in `packages/geo`.
- **Best window.** The **soonest** contiguous run of `go` hours within the horizon, as
  `{ start, end, peakWindMs }` with an **exclusive** `end` boundary (a single go-hour reads as
  a 1h span). "Soonest" beats "longest" — a rider wants to know when they can go out *today*.
- **CAPE.** Convective Available Potential Energy (J/kg) — the **pre-storm** lead-time signal.
  `weather_code` only reaches 95 once lightning is already active; CAPE downgrades the verdict
  *before* the storm code appears.
- **Kind.** The cache partition: `forecast` (atmosphere) vs `marine` (sea). `pgEnum`
  `weather_kind`.
- **Freshness.** `{ fetchedAt, modelRun, stale }` — when we fetched, which model run produced
  the data, and whether our copy is stale (fetch failed, or aged past the model's update
  interval).
- **Hot set.** The spots worth refreshing on a cadence (D-004) = favorited published spots
  today (active alarms → RFC-0008, recently-viewed → P1). Everything else is fetched lazily on
  first request.

## 5. Data Model (Drizzle)

Two tables in `src/db/schema.ts`, plus the reused `sport` enum and a new `weather_kind` enum.
Both follow the `id` (integer identity, internal) + `uid` (text uuid, public) pattern; all
timestamps are `timestamptz` precision 3 (UTC, [[../otonom-kararlar]] §6); the payload is
`jsonb` typed `.$type<JsonValue>()`; stored quantities are canonical SI (D-006).

**`weather_cache`** — the demand-driven cache (D-004), one row per `(spotUid, kind)`.

| Column       | Type                        | Rationale                                                                                          |
| ------------ | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`         | integer identity PK         | Internal key; never exposed.                                                                        |
| `uid`        | text uuid (default)         | Public id (unused in URLs here — the cache is addressed by spot, but the pattern is kept uniform).  |
| `spotUid`    | text, not null              | Keyed by the spot's **public uid**, not its internal id, so weather stays decoupled from spot's ids. |
| `kind`       | `weather_kind` enum         | `forecast` \| `marine` — separate rows so each has its own TTL and can be fetched/served independently. |
| `fetchedAt`  | timestamptz(3), not null    | When *we* fetched — half of the freshness computation.                                              |
| `modelRun`   | timestamptz(3), nullable    | The model run this payload came from. Currently written `null` (the run time is read globally from `weather_model_meta`); the column exists so a provider that returns a per-payload run can populate it. |
| `payload`    | jsonb `JsonValue`, not null | The whole normalized-SI provider payload (current + hourly series). Verdicts are derived on read, not stored. |
| `expiresAt`  | timestamptz(3), not null    | `fetchedAt + TTL`. The cache-hit predicate is `expiresAt > now`.                                     |
| `createdAt`/`updatedAt` | timestamptz(3)   | Standard audit columns.                                                                             |

Indexes: `uniqueIndex("weather_cache_spot_kind_key").on(spotUid, kind)` — the upsert conflict
target and the read key (one live row per spot per kind); `index("weather_cache_expires_at_idx")
.on(expiresAt)` — supports a future TTL sweep / eviction job.

**`weather_model_meta`** — global model-run metadata, **one row per model**, shared across all
spots (the "updated Xm ago / stale" story).

| Column                    | Type                     | Rationale                                                     |
| ------------------------- | ------------------------ | ------------------------------------------------------------ |
| `id` / `uid`              | identity / text uuid     | Standard keys.                                                |
| `model`                   | text, **unique**         | e.g. `icon_seamless`. Unique → upsert conflict target.       |
| `lastRunAvailabilityTime` | timestamptz(3), nullable | When the provider's latest run became available (from `model-metadata`). |
| `updateIntervalSec`       | integer, nullable        | The model's refresh cadence; drives both the stale check and the refresh cadence intent. |
| `fetchedAt`               | timestamptz(3), not null | When we last refreshed this metadata row.                    |
| `createdAt`/`updatedAt`   | timestamptz(3)           | Audit.                                                        |

**Enums.** `weatherKindEnum = pgEnum("weather_kind", ["forecast", "marine"])`. The `sportEnum`
(`windsurf, wingfoil, sailing, kitesurf, sup, kayak, other`) is reused from RFC-0004 — a
cross-cutting enum, not redefined here.

**Migration.** Both tables landed via `npm run db:gen`. Because the DB was never applied in
this phase (see [[../otonom-kararlar]] §28), the per-RFC migrations were consolidated into a
single clean `0000` snapshot; the per-RFC schema evolution survives in the `schema.ts` git
history. Exported types: `WeatherCache` / `NewWeatherCache`, `WeatherModelMeta` /
`NewWeatherModelMeta` (all `$inferSelect` / `$inferInsert`).

## 6. API Surface (routes + OpenAPI)

| Method | Path                            | Auth              | Summary                                                    |
| ------ | ------------------------------- | ----------------- | ---------------------------------------------------------- |
| GET    | `/v1/spots/:uid/conditions`     | anonymous or Clerk | Now-cast conditions + verdict + best window + sea + freshness |
| GET    | `/v1/spots/:uid/forecast`       | anonymous or Clerk | Hourly (48h) + daily strip, each hour/day with a verdict   |

Both routes live in `weatherRoute` and are mounted under `/v1/spots` alongside `spotRoute`
(distinct sub-paths, so both routers coexist). The router applies `authenticate` to `*`.

**Auth.** The `authenticate` middleware accepts **either** an anonymous JWT **or** a Clerk
session token and sets `c.var.user` (D-002). Weather/spot must be readable **before login**, so
the anonymous token is sufficient — no ownership check (weather is not user-scoped).

**`GET /v1/spots/:uid/conditions`** — operationId `getSpotConditions`, tag `weather`.
- **Request.** Param `spotUidParamSchema` `{ uid: z.string().uuid() }`; query
  `weatherQuerySchema` `{ sport?: sportEnum }`. `sport` is optional context; when omitted it
  defaults to the spot's first supported sport. A `sport` the spot does not support → 400.
- **Response** `successResponseSchema(conditionsResponseSchema)` → `{ data: … }`
  (`.meta({ ref: "ConditionsResponse" })`):

  ```jsonc
  {
    "spotUid": "…",
    "sport": "windsurf",
    "current": {
      "time": "2026-07-11T12:00", "windSpeedMs": 10.2, "windGustsMs": 12.4,
      "windDirectionDeg": 270, "weatherCode": 3, "temperatureC": 24.5,
      "windSide": "onshore"          // null when the spot has no shoreBearingDeg
    },
    "decision": "go",                // go | watch | skip
    "confidence": "high",            // low | medium | high
    "bestWindow": { "start": "2026-07-11T13:00", "end": "2026-07-11T18:00", "peakWindMs": 12.9 },
    "sea": { "waveHeightM": 0.4, "seaSurfaceTemperatureC": 22.0 },  // null if marine unavailable
    "freshness": { "fetchedAt": "2026-07-11T11:58:00.000Z", "modelRun": "2026-07-11T06:00:00.000Z", "stale": false }
  }
  ```
- **Status.** `200` on success. `400` (`FORM_ERROR`) for an unsupported `sport`; `404`
  (`NOT_FOUND`) if the spot uid is unknown/unpublished (raised by the spot port);
  `401`/`403` from `authenticate`; `502` (`EXTERNAL_SERVICE_ERROR`) only when the provider
  fails **and** there is no cache to fall back to.
- **Errors.** `WEATHER_UNSUPPORTED_SPORT` (`FORM_ERROR`); `SPOT_NOT_FOUND` (`NOT_FOUND`, from
  the spot port); `EXTERNAL_SERVICE_ERROR` (Open-Meteo unreachable / non-OK, no stale cache).

**`GET /v1/spots/:uid/forecast`** — operationId `getSpotForecast`, tag `weather`.
- **Request.** Same param + query schemas as above.
- **Response** `successResponseSchema(forecastResponseSchema)` (`.meta({ ref: "ForecastResponse" })`):

  ```jsonc
  {
    "spotUid": "…",
    "sport": "windsurf",
    "hourly": [
      { "time": "2026-07-11T12:00", "windSpeedMs": 10.2, "windGustsMs": 12.4,
        "windDirectionDeg": 270, "weatherCode": 3, "temperatureC": 24.5, "decision": "go" }
      // … up to 48 entries
    ],
    "daily": [
      { "date": "2026-07-11", "maxWindMs": 13.1, "decision": "go" }
      // … up to 11 UTC days; decision = the day's BEST-hour verdict
    ],
    "freshness": { "fetchedAt": "…", "modelRun": "…", "stale": false }
  }
  ```
- **Status / Errors.** Identical to `conditions` (both go through the same fetch/verdict path).

## 7. Services & Business Logic

### 7.1 The provider seam (`packages/open-meteo`)

`WeatherProvider` is the DIP boundary — the service depends on this interface, never on the
concrete client, so a second source fits the same shape:

```typescript
export interface WeatherProvider {
  fetchForecast(lat: number, lon: number): Promise<ForecastPayload>;
  fetchMarine(lat: number, lon: number): Promise<MarinePayload>;
  fetchModelMeta(model: string): Promise<ModelMeta>;
}
export const FORECAST_MODEL = "icon_seamless";
```

All payload types (`ForecastCurrent`, `ForecastHourly`, `ForecastPayload`, `MarineHourly`,
`MarinePayload`, `ModelMeta`) are canonical SI with explicit-unit field names
(`windSpeedMs`, `waveHeightM`, `temperatureC`, `capeJkg`, …). `OpenMeteoClient implements
WeatherProvider` is the first (and today only) implementation; because it does external HTTP it
lives in `packages/`, not in a domain repository.

**Open-Meteo mapping** ([[../weather-openmeteo-mapping]]). Requests pin units and cell selection
so the response is already SI and coastal-appropriate:

| Request param        | Value              | Why                                                                   |
| -------------------- | ------------------ | --------------------------------------------------------------------- |
| `models`             | `icon_seamless`    | **Pinned** — served payload must describe the *same* model whose run/interval we read for freshness. A bare `best_match` resolves per-location and makes the "updated Xm ago / model run" story inconsistent. `icon_seamless` is ICON global+EU stitched — solid for the Aegean beachhead (D-007). |
| `wind_speed_unit`    | `ms`               | Canonical SI store (D-006); knots are a client concern.               |
| `temperature_unit`   | `celsius`          | SI store.                                                             |
| `precipitation_unit` | `mm`               | SI store.                                                             |
| `timezone`           | `UTC`              | Cache is shared across clients; each client localizes. Daily roll-up groups by UTC day (fast-follow to align to local day). |
| `cell_selection`     | `sea`              | Prefer the sea grid cell for coastal spots (vs the nearest land cell). |
| `forecast_days`      | `11`               | Spot Detail wants a 10-day strip → request ≥ 11.                       |

Forecast `hourly` fields fetched: `wind_speed_10m, wind_gusts_10m, wind_direction_10m,
weather_code, temperature_2m, apparent_temperature, precipitation, precipitation_probability,
cape, cloud_cover`. Forecast `current` (the "now" tick): `wind_speed_10m, wind_gusts_10m,
wind_direction_10m, weather_code, temperature_2m` — honestly a **model nowcast**, not a station
observation. Marine `hourly`: `wave_height, wave_period, wave_direction,
sea_surface_temperature, sea_level_height_msl` (tide is included via MSL height). Model
metadata reads `last_run_availability_time` (unix seconds → `Date`) and
`update_interval_seconds`.

`getJson()` centralizes error handling: a thrown `fetch` or a non-OK response both raise
`GenericError("EXTERNAL_SERVICE_ERROR")` (logged once). Array parsing is defensive
(`nums`/`strs` coerce and default to `[]`) because the body is untrusted external JSON. The base
URLs are read **lazily** from `globalConfig.config.openMeteo.{forecastUrl,marineUrl}` at call
time, keeping the module import-safe (foundation invariant, RFC-0001 §7).

### 7.2 The pure decision engine (`decision.ts`)

`decision.ts` imports only *types* and `windSide` from `packages/geo` — no repository, no
config, no clock. Every function is pure `(numbers) → verdict`, which is why the safety logic is
exhaustively unit-tested (§13).

**Per-sport wind bands** (canonical m/s; knot annotations in the source; 1 kt ≈ 0.5144 m/s).
Research-backed for a general/**intermediate** skill level from watersports sources
([[../otonom-kararlar]] §24):

| Sport     | too light (skip) | **IDEAL (go)** m/s | too strong (skip) | knots (min / ideal / max) | note                              |
| --------- | ---------------- | ------------------ | ----------------- | ------------------------- | --------------------------------- |
| windsurf  | < 5.1            | **6.2 – 12.9**     | > 18.0            | <10 / 12–25 / >35         | planing starts ~12 kt, sweet 15–25 |
| wingfoil  | < 5.7            | **6.7 – 11.3**     | > 15.4            | <11 / 13–22 / >30         | practical min 12–15, ideal 16–20   |
| kitesurf  | < 5.1            | **6.2 – 12.9**     | > 17.0            | <10 / 12–25 / >33         | min ~12, sweet 15–25               |
| sailing   | < 2.1            | **4.1 – 8.2**      | > 12.9            | <4 / 8–16 / >25           | dinghy reefs/returns ~20 kt        |
| sup       | 0                | **0 – 2.6**        | > 7.7             | — / 0–5 / >15             | **inverted**: flat water is best   |
| kayak     | 0                | **0 – 3.1**        | > 8.2             | — / 0–6 / >16             | **inverted**; sea kayak tolerates more |
| other     | < 2.1            | **4.1 – 10.3**     | > 15.4            | <4 / 8–20 / >30           | generic watersport                 |

**`computeDecision(input)`** — the verdict for a single hour. Modifiers can **only downgrade**
(`worse(a, b)` returns the more severe of two verdicts via a `go<watch<skip` severity map):

1. **Thunderstorm short-circuit** — `weather_code ≥ 95` → `skip` immediately (nothing else can
   rescue it).
2. **Base band** — `wind < minMs` → `skip`; `< idealMinMs` → `watch`; `≤ idealMaxMs` → `go`;
   `≤ maxMs` → `watch`; else `skip`. SUP/kayak's `idealMinMs = 0` makes light/flat water `go`
   and turns "more wind" into the *too-strong* skip case — the inverted logic.
3. **Overpowering gusts** — `gust > maxMs` → downgrade to at least `watch`, even when the mean
   wind sits in the ideal band.
4. **Offshore safety (scaled)** — using `windSide(shoreBearingDeg, windDirectionDeg)`:
   `offshore` → `skip` if `wind > idealMaxMs` (strong wind blows the rider out to sea, the
   canonical life-threatening case), else `watch`; `cross-offshore` (still a strong seaward
   component) → at least `watch`. Only applied when both `shoreBearingDeg` and
   `windDirectionDeg` are present.
5. **Pre-storm CAPE** — `cape > 2500` → `skip`; `> 1000` → `watch`. This fires *before*
   `weather_code` catches up to 95, buying lead time.
6. **Heavy precipitation** — `weather_code ∈ {65,67,75,82,86}` → at least `watch`.

**`computeConfidence({ stale, gustSpreadMs, precipitationProbability })`** — staleness
dominates: `stale` → `low`; else `gustSpreadMs > 8` or `precipitationProbability > 60` →
`medium`; else `high`.

**`bestWindow(hourly, sport, shoreBearingDeg, horizonHours = 48)`** — scans up to `horizonHours`
hours, runs `computeDecision` per hour, and returns the **soonest** contiguous run of `go` hours
as `{ start, end, peakWindMs }`, or `null` when nothing qualifies. The `end` is the **exclusive**
hour-boundary after the last go-hour, so a single go-hour at 13:00 reports `end = 14:00` (a 1h
span), not `13:00–13:00`. A run still open at the horizon end closes at the last scanned hour.

### 7.3 Orchestration (`WeatherService extends BaseUseCase`)

Constructed with `(weatherRepository, weatherProvider, spotPort)`; reads config via
`this.config`, holds no `dbClient` (the layer contract). TTLs are `FORECAST_TTL_MS = 1h` (the
"now" tick wants freshness) and `MARINE_TTL_MS = 3h` (waves move slower).

**`WeatherSpotPort` (ISP/DIP).** Weather needs only two things from the spot domain:

```typescript
export interface WeatherSpotPort {
  getGeoByUid(uid: string): Promise<SpotGeo>;   // coords + shoreBearingDeg + supportedSports
  listHotSpotGeos(): Promise<SpotGeo[]>;         // favorited published spots (D-004)
}
```

`SpotService` satisfies this; weather never sees the rest of the spot surface. `getGeoByUid`
raises `NOT_FOUND` for an unknown/unpublished spot. RFC-0006 (activity → weather) is expected to
follow the same narrow-port pattern.

**`getConditions(spotUid, query)`** — resolve geo + sport → `getOrFetchForecast` → best-effort
`getOrFetchMarine` (`.catch(() => null)`, so a marine outage never breaks conditions) →
compute `windSide` from the current block → `computeDecision` (the `current` block carries no
CAPE, so the nearest hour's `capeJkg[0]` is used) → `computeConfidence` (gust spread =
`gust − mean`, precip odds from hour 0) → `bestWindow` → assemble the response including
`freshness`. `sea` is `null` when marine is unavailable.

**`getForecast(spotUid, query)`** — resolve geo + sport → `getOrFetchForecast` → map the first
48 hourly entries, each carrying its own `computeDecision` → `deriveDaily` → `freshness`.
`deriveDaily` groups hours by UTC date (`time.slice(0,10)`), taking `maxWindMs` and the day's
**best-hour** (least-severe) verdict as the headline.

**`resolveSport(spot, requested?)`** — an explicit `sport` must be in `spot.supportedSports`,
else `FORM_ERROR / WEATHER_UNSUPPORTED_SPORT`; otherwise defaults to `supportedSports[0] ?? "other"`.

**Cache-or-fetch with stale-serve (`getOrFetchForecast`).** Read `weather_cache` for
`(spotUid, "forecast")`; if present and `expiresAt > now` → serve it (`stale: false`). On a
miss/expiry, fetch + upsert. If the fetch **throws** and a (now-expired) cache row exists →
serve the stale copy with `stale: true` and a warn log, rather than erroring — graceful
degradation. If there is no cache at all, the provider error propagates (→ 502). `getOrFetchMarine`
mirrors this but **without** the stale-serve fallback (a documented fast-follow, §16).

**Freshness (`freshness`).** Combines the fetch outcome with global model metadata: `stale =
fc.stale || agedOut`, where `agedOut = updateIntervalSec != null && (now − fetchedAt) >
updateIntervalSec·1000`. So a copy is stale if the provider fetch failed **or** it has aged past
the model's own update interval ([[../weather-openmeteo-mapping]] §3). `modelRun` is the pinned
model's `lastRunAvailabilityTime`, read from `weather_model_meta` for `FORECAST_MODEL` — because
the forecast is pinned to that same model, the metadata describes the payload that was served.

**Hot-set refresh (`refreshHotSet`).** `listHotSpotGeos()` → for each spot,
`fetchAndCacheForecast` + `fetchAndCacheMarine` inside a per-spot `try/catch`, so one spot's
failure never aborts the batch; returns `{ hotSpots, refreshed }`. **`refreshModelMeta`** fetches
`fetchModelMeta(FORECAST_MODEL)` and upserts the single metadata row.

## 8. Background Jobs (Trigger.dev)

Both are `schedules.task` crons (no payload), each following the RFC-0001 task lifecycle:
`initializeForTrigger()` + `createDBManagerForTrigger()` + `buildContainer(dbManager)` in a
`try`, `Tracking.captureException` on error, `finalizeTrigger(dbManager)` in `finally`. They are
invoked by the scheduler, never by a route; the service methods they call are the same ones a
route could call.

| Task                          | Cron          | maxDuration | Retry        | Concurrency | Does                                                        |
| ----------------------------- | ------------- | ----------- | ------------ | ----------- | ---------------------------------------------------------- |
| `weather-refresh`             | `*/30 * * * *` | 300s        | maxAttempts 3 | limit 1     | `weatherService.refreshHotSet()` — re-fetch favorited spots' forecast + marine. Demand-driven (D-004); **never** the whole world. |
| `weather-model-meta-refresh`  | `0 * * * *`    | 120s        | maxAttempts 3 | limit 1     | `weatherService.refreshModelMeta()` — refresh global model-run metadata. Cheap + global → hourly is plenty. |

**Idempotency / recompute.** Both are pure upserts (`onConflictDoUpdate` on `(spotUid, kind)`
and on `model`), so a retry or overlap is safe; `concurrencyLimit: 1` prevents a slow run from
stacking. Verdicts are never stored — only raw payloads — so the engine can be tuned and
everything recomputes on the next read.

## 9. Dependencies & Integrations

- **Open-Meteo** — `api.open-meteo.com` (forecast + model-metadata) and
  `marine-api.open-meteo.com` (marine). **No API key** for non-commercial use (`apikey` optional
  commercially). Env (validated by `GlobalConfig`, with defaults):
  `OPEN_METEO_BASE_URL` (default `https://api.open-meteo.com/v1`),
  `OPEN_METEO_MARINE_URL` (default `https://marine-api.open-meteo.com/v1`) — surfaced as
  `config.openMeteo.{forecastUrl, marineUrl}`.
- **RFC-0004 (spot)** — the `WeatherSpotPort` slice (`getGeoByUid`, `listHotSpotGeos`); the
  spot's `shoreBearingDeg` is the IP that turns wind direction into a side; favorites feed the
  hot set. Passed explicitly at the composition root:
  `createWeatherModule({ ...deps, spotPort: spotServices.spotService })`.
- **RFC-0001 (foundation)** — `BaseUseCase`/`BaseRepository`, `GenericError`, `HTTPResponse`,
  the DB manager + Trigger lifecycle, `packages/geo` (`windSide`), `packages/logger`.
- **Seams this RFC exposes.** `WeatherProvider` (add a second source — METAR/buoy — behind the
  same interface); the pure `decision.ts` engine (reusable by alarms RFC-0008); `WeatherService`
  as a port for RFC-0006 (activity → weather context).

## 10. Security & Privacy

- **No PII.** Weather is spot-scoped, not user-scoped; nothing personal is read, stored, or
  logged. Cache rows key on the spot's public uid.
- **Auth without ownership.** `authenticate` is required (anonymous JWT or Clerk) so unauth'd
  traffic can't hammer the provider through us, but there is no per-user authorization — any
  authenticated caller may read any published spot's weather (pre-login browsing is a product
  requirement).
- **Input hardening.** `uid` is `z.string().uuid()`; `sport` is constrained to the enum and
  re-checked against the spot's supported set. The raw Open-Meteo body is treated as untrusted
  (defensive `nums`/`strs` coercion); full Zod validation of the provider response is a
  fast-follow (§16).
- **Attribution.** Open-Meteo attribution is required and shown in the app's "Data sources"
  screen.
- **Rate limiting.** Deferred to the platform middleware (RFC-0002+); the demand-driven cache +
  hot-set cron already bound the provider fan-out.

## 11. Observability

- **Logging** (`createLogger("WeatherService")` / `"open-meteo"`): a `warn` when a stale
  forecast is served after a fetch failure (with `spotUid`), a `warn` per hot-set spot that
  fails to refresh (`spotUid` + error), and `error` logs in the client for a failed/non-OK
  provider request (with status). The crons `logger.info` their result summary
  (`{ hotSpots, refreshed }` / "model meta refreshed").
- **Exception reporting.** Provider failures surface as `EXTERNAL_SERVICE_ERROR`, which the
  error-handler middleware reports (RFC-0001 §11) — it means Open-Meteo is unreachable and no
  cache was available. Cron failures are captured via `Tracking.captureException` with the
  `taskId`.
- **Not reported (by design).** A stale-serve is a successful degraded response (warn, not an
  exception); an unsupported-sport `FORM_ERROR` and a `NOT_FOUND` are expected client errors.

## 12. Performance & Scalability

- **Read path.** A conditions/forecast request is normally **one indexed row read** per kind
  (`weather_cache_spot_kind_key`) plus the pure in-memory engine — no provider call on a cache
  hit. Verdicts and best-window are recomputed per request (cheap: a bounded loop over ≤ 48–264
  hourly points) rather than stored, so tuning the bands never requires a backfill.
- **Provider fan-out is bounded.** The demand-driven cache means the provider is hit only on a
  cold spot or an expired kind; the cron only re-fetches the hot set, never the catalogue. TTLs
  (1h forecast / 3h marine) cap cold-fetch frequency per spot.
- **Payload size.** The full 11-day hourly series is stored as one jsonb blob; responses trim to
  48 hourly + ~11 daily entries, keeping the wire payload small.
- **Known scaling gaps (deferred, §16).** (a) **Thundering herd** — when a popular spot's cache
  expires, N concurrent requests each trigger a fetch; a single-flight per `(spotUid, kind)` is
  the fix. (b) **Cadence-blind refresh** — the cron re-fetches *all* favorites every 30 min
  regardless of freshness; it should skip still-fresh rows, honor `updateIntervalSec`, and use
  bounded concurrency. Both are acceptable at beachhead scale (D-007) and flagged.

## 13. Testing Strategy

- **`decision.spec.ts` (pure engine).** The correctness heart of the RFC — no mocks needed.
  Covers: windsurf go/watch/skip across the band; the SUP inversion (flat = go, windy = skip);
  thunderstorm forcing skip; offshore downgrading `go → watch` and strong-offshore all the way
  to `skip`; overpowering gusts; pre-storm CAPE at both thresholds; confidence (stale → low,
  gusty/rainy → medium, steady+fresh → high); and `bestWindow` finding the soonest go-run with
  the exclusive-end boundary and returning `null` when nothing qualifies.
- **`weather.service.spec.ts`.** Mocks the repository, the `WeatherProvider`, and the
  `WeatherSpotPort`. Covers: fetch-on-miss + verdict + `windSide` derivation; serve-fresh-cache
  (no provider call); reject an unsupported sport (`FORM_ERROR`); **serve stale cache on fetch
  failure** (`freshness.stale === true`, verdict still computed); and `refreshHotSet` tolerating
  one spot's failure (`hotSpots` vs `refreshed`).
- **`open-meteo.spec.ts`.** Mocks `global.fetch`. Asserts SI-field normalization, that the URL
  pins `wind_speed_unit=ms` / `cell_selection=sea` / `forecast_days=11`, model-metadata unix →
  `Date` parsing, and `EXTERNAL_SERVICE_ERROR` on a non-OK response.
- **Pre-ship gate.** `lint:biome:fix`, `lint:type`, `lint:imports`, `test` all green.

## 14. Alternatives Considered

- **Multiple weather providers / ensembles at MVP.** Rejected — one honest source (Open-Meteo)
  keeps cost and complexity down (D-004). The `WeatherProvider` interface keeps the door open;
  the real gap (live observation) is deferred, not designed away.
- **`best_match` model vs a pinned model.** Rejected `best_match` — it resolves per-location, so
  the served payload and the model-metadata we read for freshness would describe *different*
  models, making "updated Xm ago / model run" inconsistent. Pinned `icon_seamless` makes
  freshness truthful ([[../otonom-kararlar]] §26).
- **Storing computed verdicts / best-window in the cache.** Rejected — they are cheap to
  recompute and would force a backfill every time a band is tuned. Only the raw SI payload is
  stored; verdicts derive on read (RFC-0005 §12).
- **Global periodic refresh of all spots.** Rejected outright (D-004) — burns API + compute on
  unwatched spots. Demand-driven cache + hot-set cron instead.
- **Ignoring CAPE / single-step offshore (the original engine).** Fixed during review
  ([[../otonom-kararlar]] §25): the engine used to say "go" until lightning struck (CAPE was
  fetched but unused) and treated offshore as a single narrow-band step. Both are life-safety,
  so CAPE now gives pre-storm lead time and offshore scales with wind strength.
- **UTC vs local-day daily roll-up.** Kept UTC (`timezone=UTC`) so the cache is shared across
  clients (D-006); local-day alignment via client aggregation or `timezone=auto` is a
  fast-follow.

## 15. Implementation Plan (checklist)

1. ✅ `weather_kind` enum + `weather_cache` + `weather_model_meta` tables in `schema.ts`;
   `dbSchema` + inferred types; `npm run db:gen`.
2. ✅ `packages/open-meteo` — `WeatherProvider` interface, SI payload types, `FORECAST_MODEL`
   pin, `OpenMeteoClient` (forecast / marine / model-metadata), defensive parsing.
3. ✅ `errors.ts` (`WeatherReason.UNSUPPORTED_SPORT`); `schemas/index.ts` (param/query +
   `ConditionsResponse` / `ForecastResponse` with `.describe()` + `.meta({ ref })`).
4. ✅ `decision.ts` (pure): `THRESHOLDS`, `computeDecision`, `computeConfidence`, `bestWindow`
   + `decision.spec.ts`.
5. ✅ `repositories/weather.repository.ts` (`findCache`/`upsertCache`/`findModelMeta`/
   `upsertModelMeta`).
6. ✅ `services/weather.service.ts` (`WeatherSpotPort`, cache-or-fetch + stale-serve, freshness,
   orchestration, hot-set) + `weather.service.spec.ts`.
7. ✅ `tasks/weather-refresh.task.ts` + `tasks/weather-model-meta-refresh.task.ts`.
8. ✅ `routes/v1.ts` (`getSpotConditions` / `getSpotForecast`, `authenticate`, validators);
   `weather.module.ts` (`createWeatherModule({ db, spotPort })`); wire into `container.ts`;
   mount `weatherRoute` under `/v1/spots` in `domains/index.ts`.
9. ✅ `lint:biome:fix` · `lint:type` · `lint:imports` · `test` green; convention +
   principal-architect reviews folded in ([[../otonom-kararlar]] §24–27).

## 16. Open Questions & Resolved Decisions

**Open — needs Berkay's input (does not block):**
- ❓ **Wind bands are research-backed defaults, not yet confirmed.** `THRESHOLDS` in `decision.ts`
  are intermediate-level values derived from watersports sources (windup.live, mackiteboarding,
  kiteworldwide, dinghy/Beaufort guides, SUP/kayak safety guides — [[../otonom-kararlar]] §24),
  converted to m/s with knot annotations in the source. Two follow-ups: (a) a one-line
  fine-tune if experience says a band is off; (b) **per-skill-level bands** — a beginner
  windsurfer's ceiling is ~18 kt, not 25 — which requires threading the user's `experience` into
  the verdict (bundled with the primary-sport plumbing fast-follow below). Ships today as a
  single intermediate table.

**Resolved:**
- ✅ **Cache key = per-spot** (`spotUid + kind`); lat/lon bucketing deferred.
- ✅ **Verdicts / best-window derived per request** (cheap, not cached).
- ✅ **Safety downgrades: CAPE + scaled offshore** ([[../otonom-kararlar]] §25). CAPE > 1000 →
  watch, > 2500 → skip (pre-storm lead time); offshore scales with wind (strong → skip, else
  watch; cross-offshore → watch).
- ✅ **Freshness: model pinned + stale from `updateInterval`** ([[../otonom-kararlar]] §26).
  `icon_seamless` pinned so payload and metadata describe the same model; `stale = fetch-failed
  OR aged past `updateIntervalSec``.
- ✅ **weather → spot via a narrow port** (`WeatherSpotPort`, ISP/DIP); RFC-0006 follows suit.
- ✅ **Provider abstracted** (`WeatherProvider`) so a second source fits the same interface
  ([[../otonom-kararlar]] §28).

**Deferred fast-follows** ([[../otonom-kararlar]] §27):
- ⏸️ **Thundering-herd** — in-process single-flight per `(spotUid, kind)`.
- ⏸️ **Cadence-aware refresh** — skip still-fresh rows, honor `updateIntervalSec`, bounded
  concurrency (today the cron re-fetches all favorites every 30 min).
- ⏸️ **Primary-sport default** — server-side `?sport=` default from the user profile (today it
  falls to the spot's first sport; the client passes the user's primary sport explicitly).
- ⏸️ **Live observation** — a real station/METAR/buoy source behind `WeatherProvider` (the one
  genuine product gap; MVP labels `current` honestly as a model nowcast).
- ⏸️ **`wind-field` endpoint (P1)** — wind-vector grid data; the client draws it.
- ⏸️ Marine stale-fallback; surface tide/wave/apparent-temp + visibility/UV in the response;
  local-day daily alignment; Zod-validate the raw Open-Meteo body.

## 17. References

[[../weather-openmeteo-mapping]] · [[decisions]] D-003/D-004/D-006/D-007 ·
[[../otonom-kararlar]] §24–27 · [[../metrics-catalog]] · [[0004-spot]] · [[0001-foundation]] ·
[[../SPLASH-OVERVIEW]]
