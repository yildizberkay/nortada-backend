# RFC-0012: Virtual & Private Spots (point verdicts anywhere, save-on-intent)

|              |                                                   |
| ------------ | ------------------------------------------------- |
| **RFC**      | 0012                                              |
| **Title**    | Virtual & Private Spots (spot-grade verdicts for any coordinate; user-owned spots born on alert/favorite) |
| **Status**   | 🚧 In Progress                                    |
| **Depends on** | RFC-0005 (weather), spot conditions/forecast pipeline, alerts engine |
| **Domain(s)** | feature/spots, feature/alerts                    |
| **Updated**  | 2026-07-19                                        |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

---

## 1. Summary

A user taps ANY map location and gets the full spot experience — verdict,
best window, hourly, 10-day outlook — even though the catalog has no spot
there. Product driver (Berkay, 2026-07-19): *"o spotu işlememişizdir fakat
adam orada spot olduğunu biliyordur; bir spot gibi muamele görülmesi lazım."*

Three identity tiers, with hard rules about persistence:

1. **Virtual spot** — ephemeral. `GET`-style lookup: coordinate + sport →
   the SAME payload shape a catalog spot's conditions/forecast returns.
   **Never persisted.** Viewing leaves no trace, no row, no log-derived
   shadow list.
2. **Private spot** — born ONLY when the user sets an alert on or favorites
   a virtual spot (save-on-intent; there is no bare "save" action). Owned by
   that user, named by that user at creation, never published, invisible to
   everyone else. Alerts, favorites and track sessions bind to its id.
3. **Catalog spot** — the existing public tier. Unchanged by this RFC.
   (A promote/suggest bridge is explicitly OUT of scope.)

## 2. Decisions (settled with product, 2026-07-19)

- **Two coordinates, always.** `requested` (the exact tap; what the user
  sees, what a private spot stores) vs `gridKey` (requested rounded to
  0.01°; the cache/scoring key). Responses echo both. Rounding is free
  fidelity-wise: model grids are 1–9 km, 0.01° ≈ 1.1 km.
- **No shore data → the derived info is simply absent.** Arbitrary
  coordinates have no shore normal, so `windSide`/offshore advisories are
  null/omitted for virtual and private spots. The verdict engine scores
  without the offshore penalty — the display and alerts stay consistent
  with what is known. Alerts are unaffected structurally: rules condition
  on raw thresholds (wind range, gust cap, directions, days/hours,
  confidence), never on windSide.
- **Save-on-intent only.** Alert creation and favoriting are the only two
  gestures that create a private spot; both prompt for a NAME at that
  moment (reverse-geocode may prefill; the stored name never silently
  changes afterward; user can rename).
- **Not in scope / not V1:** land-vs-water detection (tapping land yields a
  technically-honest, semantically silly verdict — accepted), any
  catalog-suggestion bridge, any dedupe (private data needs none), alert
  rules keyed to bare coordinates (alerts always go through a private
  spot id).

## 3. API (step 1 — implemented)

- `GET /v1/spots/virtual/conditions?lat&lon&sport` and
  `GET /v1/spots/virtual/forecast?lat&lon&sport` — the catalog endpoints'
  exact payload shapes plus a `coordinates: { requested, gridKey }` block,
  so the client renders a virtual spot through the same pipeline. `sport`
  is REQUIRED (a bare coordinate has no supported-sports default);
  `windSide` is always null. Implemented as `WeatherService
  .getConditionsAt/.getForecastAt` over the shared `conditionsFor/
  forecastFor` internals; cached in `weather_cache` under the synthetic
  uid `virtual:<gridLat>,<gridLon>` (no FK — no spot row is ever touched),
  same TTLs as catalog spots.
- `POST /v1/spots/private` `{ name, latitude, longitude, sport }` →
  private spot row (implemented). One table, no new columns: the existing
  `watersport_spot` gains enum values `status: private` + `source:
  user_private`; ownership = `createdBy` ("sahip varsa private"). Cap: 50
  per user (`SPOT_PRIVATE_LIMIT_REACHED`). Stored coordinate is the exact
  tap, never the grid key.
- Private spots ride the EXISTING spot surfaces for their owner
  (implemented): `nearby`/`search`/`detail` add an owner-visibility filter
  (published OR own-private); favorites accept own-private and the weather
  hot set refreshes favorited private spots; `getGeoByUid` (the weather
  port, no user context) resolves private rows — the unguessable uuid is
  the capability, list surfaces are where privacy is enforced. Alert
  evaluation will resolve private uids the same way once server-side
  alerts exist (RFC-0008).
- Client identity note: the iOS app renders a virtual spot through the same
  `Spot`/`SpotForecast` pipeline with a coordinate-derived transient id;
  nothing client-side persists until the private row exists.

## 4. Open questions

- Alert rule linkage today is `spotName` string — private spots should push
  the alert model toward uid-based linkage (name collisions between a
  private and catalog spot must not cross-fire).
- Per-user private spot cap (abuse/cost guard) — propose a generous fixed
  cap (e.g. 50) rather than metering.
- Reverse geocoding provider/quota for the name prefill (client-side
  CLGeocoder suffices for V1; server stays out of naming).
