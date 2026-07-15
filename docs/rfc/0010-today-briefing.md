# RFC-0010: Today Briefing

|                |                                          |
| -------------- | ---------------------------------------- |
| **RFC**        | 0010                                     |
| **Title**      | Today Briefing (top pick + alternatives) |
| **Status**     | ✅ Completed                             |
| **Step**       | 6                                        |
| **Depends on** | RFC-0004 (spot), RFC-0005 (weather)      |
| **Domain(s)**  | feature/briefing                         |
| **Updated**    | 2026-07-14                               |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

---

## 1. Summary

This RFC delivers `GET /v1/me/briefing` — the endpoint behind the iOS Today screen: one
ranked **top pick** among the user's candidate spots (favorites, or a nearby fallback), up to
three **alternatives**, an overall **briefing state** (`goodNow | goodLater | risky |
noGoodWindow | lowConfidence | stale | noSpots`), and a structural **reasons** list explaining
*why* the pick is the call. The single most important design choice: the briefing is a **pure
composition layer** — a new `feature/briefing` domain with **no tables and no new weather
logic**. It consumes the spot domain (favorites, nearby) and the weather domain (conditions,
decision engine) through explicit ports, and the "why" comes from a new **pure**
`decisionReasons()` function that lives next to `computeDecision()` in `weather/decision.ts`,
so verdict and explanation can never drift apart.

## 2. Motivation & Context

- **Problem.** Today is the app's flagship screen and the only major surface still running on
  mock data. Its needs (a ranked pick, a state machine, "Why today" reasons) span favorites ×
  conditions × the decision engine — composing them client-side would duplicate the engine's
  thresholds in Swift and drift (NORTADA-OVERVIEW: "every recommendation must answer *Why?*").
- **Background.** RFC-0005 shipped the per-spot verdict/conditions engine and (2026-07-14) the
  batch conditions endpoint; RFC-0004 shipped favorites + nearby; RFC-0003 has `primarySport`.
  All the ingredients exist server-side — this RFC only arranges them.
- **Goals.**
  - One request answers the Today screen: pick + alternatives + state + reasons + sky inputs.
  - Reasons are **structural enums** (client localizes), emitted by the same module that owns
    the thresholds.
  - Deterministic, documented ranking — same inputs, same pick.
  - Favorites drive the briefing; `lat`/`lon` enables a nearby fallback for
    pre-onboarding users and adds `distanceKm` to spots.
- **Non-goals.**
  - Per-skill thresholds and the user's wind-range preferences in ranking (fast-follow with
    RFC-0005's per-skill bands).
  - Push/scheduled briefings (RFC-0008 alerts territory).
  - The Metal sky itself — the client renders; we only pass `weatherCode`/`temperatureC`.

## 3. Scope (In / Out)

- **In:** the `feature/briefing` domain — `BriefingService` behind three ports
  (favorites, nearby-spots, conditions), `decisionReasons()` in `weather/decision.ts`,
  request/response schemas, the `GET /v1/me/briefing` route, module + container wiring, unit
  tests for ranking/state/reasons.
- **Out:**
  - Caching the briefing itself (conditions are already cached per spot; composition is cheap).
  - `goodLater` day-granularity via forecast dailies (MVP uses the 48h `bestWindow` from
    conditions; day-strip reasoning is a fast-follow).
  - Recently-viewed spots as candidates (needs a view log — later phase).

## 4. Domain Model & Ubiquitous Language

- **Briefing.** The composed answer to "should I go out today, where, and why": a state, a
  pick, alternatives, and the sport it was computed for.
- **Candidate.** A spot eligible to be picked: the user's favorites, or — when the user has
  none and sent `lat`/`lon` — the nearest published spots (limit 5, radius 50 km).
- **Pick.** The best-ranked candidate with its conditions and reasons. `null` when there are
  no candidates (`state: "noSpots"`).
- **Alternative.** Candidates ranked 2–4, each with its conditions (no reasons — the client
  shows them as compact rows).
- **Briefing state.** One value the client keys its layout on, derived from the PICK's
  conditions in this order (first match wins):
  `noSpots` (no candidates survived) → `stale` (pick's freshness.stale) → `lowConfidence`
  (confidence low, fresh) → `goodNow` (decision go) → `goodLater` (bestWindow ahead within
  48h) → `risky` (decision watch AND a safety reason: offshore/cross-offshore side, gusts
  overpowering, or storm risk) → `noGoodWindow` (everything else).
- **Reason.** A structural explanation code from the decision engine's own thresholds, e.g.
  `wind_in_ideal_band`, `offshore_risk`, `gusts_overpowering`, `steady_wind`, `fresh_data`.
  The client maps codes to localized copy; the server never ships prose.

## 5. Data Model (Drizzle)

N/A — no tables. The briefing is computed per request from spot + weather (whose cache does
the heavy lifting, RFC-0005 §"demand-driven cache").

## 6. API Surface (routes + OpenAPI)

| Method | Path              | Auth               | Summary                                            |
| ------ | ----------------- | ------------------ | -------------------------------------------------- |
| GET    | `/v1/me/briefing` | anonymous or Clerk | Ranked top pick + alternatives + state + reasons   |

Mounted as `app.route("/v1/me/briefing", briefingRoute)` (the favorites pattern — one router
per sub-resource under `/v1/me`). `authenticate` on `*`.

**`GET /v1/me/briefing`** — operationId `getTodayBriefing`, tag `briefing`.
- **Query** (`briefingQuerySchema`): `sport?` (defaults to the profile's `primarySport`;
  candidates not supporting the sport are skipped), `lat?`/`lon?` (both or neither —
  `FORM_ERROR` on one alone; enables the no-favorites fallback and `distanceKm`).
- **Response** `successResponseSchema(briefingResponseSchema)` (`.meta({ ref: "BriefingResponse" })`):

  ```jsonc
  {
    "state": "goodNow",
    "sport": "windsurf",
    "pick": {                       // null when state = "noSpots"
      "spot": {                     // briefingSpotSchema — the compact slice Today renders
        "uid": "…", "name": "Dragos Coast", "locality": "İstanbul",
        "latitude": 40.908, "longitude": 29.152, "waterType": "sea",
        "supportedSports": ["windsurf", "sailing"], "distanceKm": 6.2   // null without lat/lon
      },
      "conditions": { /* ConditionsResponse — same ref as /conditions (RFC-0005) */ },
      "reasons": ["wind_in_ideal_band", "cross_shore", "steady_wind", "fresh_data"]
    },
    "alternatives": [ { "spot": {…}, "conditions": {…} } ]   // ranked 2–4, may be empty
  }
  ```
- **Status.** `200` always on auth success — an empty briefing is `state: "noSpots"`, not an
  error. `400` (`FORM_ERROR`) for `lat` without `lon` (or vice versa); `401` from `authenticate`.
- **Errors.** No domain-specific error reasons (hence no `errors.ts`); candidate-level
  failures (conditions fetch failed, sport unsupported) drop the candidate, never the request.

## 7. Services & Business Rules

**`BriefingService.getBriefing(user, query)`** — the whole domain:

1. **Sport.** `query.sport ?? profilePort.getPrimarySport(user)` (profile default is
   `windsurf` for un-onboarded users, RFC-0003).
2. **Candidates.** `favoritePort.listFavorites(user)`; if empty and `lat`/`lon` present →
   `spotPort.nearby({ lat, lon, radiusKm: 50, limit: 5 })`. Candidates not supporting the
   sport are filtered out (documented MVP behavior — per-spot sport fallback is a fast-follow).
3. **Conditions.** `weatherPort.getConditions(uid, { sport })` per candidate,
   `Promise.allSettled` in chunks of 6 (the RFC-0005 batch discipline); rejected candidates
   are logged and dropped.
4. **Ranking.** Sort by `(decision severity asc, bestWindow.start asc nulls-last,
   confidence desc, windSpeed distance to the sport's ideal-band midpoint asc)`. Stable and
   fully unit-tested; pick = first, alternatives = next three.
5. **State.** The §4 state machine over the pick's conditions.
6. **Reasons.** `decisionReasons()` for the pick only, capped at 4 (the screen shows four).

**`decisionReasons(input): DecisionReason[]`** (in `weather/decision.ts`, pure, exported,
same `DecisionInput` as `computeDecision`): emits in priority order — band verdict
(`wind_in_ideal_band` / `wind_below_ideal` / `wind_above_ideal` / `too_light` / `too_strong`),
shore-relative side (`cross_shore` / `cross_onshore` / `onshore` / `offshore_risk` /
`cross_offshore_caution`), gust character (`gusts_overpowering` / `gusty` / `steady_wind`),
storm/precip (`storm_risk` / `heavy_precipitation`), and freshness (`stale_data` /
`fresh_data`, appended by the caller who knows staleness). Sharing `THRESHOLDS` with
`computeDecision` is the whole point — one source of truth for verdict AND explanation.

## 8. Module & DI

`createBriefingModule({ db, favoritePort, spotPort, profilePort, weatherPort })` → returns
`{ briefingService }`. All four ports are minimal interfaces declared in
`briefing.service.ts` (ISP, the `WeatherSpotPort` precedent); satisfied at the composition
root by `FavoriteService`, `SpotService`, `UserProfileService`, `WeatherService`. Wired in
`src/container.ts` after weather.

## 9–12. Trigger / Config / Auth / Storage

N/A — no crons, no new config keys, standard `authenticate`, no storage. Verdict/reason logic
derives on read (RFC-0005 §12 rationale).

## 13. Testing

- `briefing.service.spec.ts` (mocked ports): ranking order (go beats watch; sooner window
  wins; confidence tiebreak), state machine per branch (incl. `noSpots`, fallback-to-nearby,
  stale-first precedence), candidate drop on conditions failure, sport filtering, lat/lon
  validation is schema-level.
- `decision.spec.ts` additions: `decisionReasons` band/side/gust/storm cases mirror the
  `computeDecision` cases so the two can't diverge silently.

## 14. Alternatives Considered

- **Client-side composition** (favorites + batch conditions in the app). Rejected: duplicates
  thresholds/reasons in Swift; the "why" must come from the engine that decided (§2).
- **Reasons as free text.** Rejected: not localizable, couples backend to copywriting.
- **Extending `computeDecision` to return `{ decision, reasons }`.** Rejected: every existing
  caller (hourly loops, dailies, batch) would pay reason-allocation for output it discards;
  a separate pure function keeps hot paths lean and shares `THRESHOLDS` anyway.
- **A briefing cache table.** Rejected: conditions are already cached per spot (1h TTL);
  composing over ≤5–10 favorites is microseconds. A cache would only add invalidation bugs.

## 15. Implementation Plan (checklist)

1. `decisionReasons` + tests in `weather/decision.{ts,spec.ts}`.
2. `feature/briefing`: schemas → service (+ports) → spec → routes → module.
3. `container.ts` + `domains/index.ts` wiring.
4. Lint/type/imports/test suite green; convention-reviewer pass.
5. iOS: `refresh-spec.sh` regenerates the client (`getTodayBriefing`).

## 16. Fast-follows

- Per-spot sport fallback (don't drop a favorite that lacks the queried sport — brief it on
  its own primary sport instead).
- `goodLater` day-granularity from forecast dailies ("best day this week" story).
- User wind-range preferences (RFC-0003 sport profiles) threading into ranking.
- Recently-viewed candidates; distance-aware ranking weight.

## 17. References

RFC-0004 (favorites, nearby) · RFC-0005 (conditions, decision engine, batch discipline) ·
RFC-0003 (`primarySport`) · [[../NORTADA-OVERVIEW]] (Today briefing product contract)
