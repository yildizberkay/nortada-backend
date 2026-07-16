# RFC-0011: Weather-Map PNG Pipeline

|              |                                                   |
| ------------ | ------------------------------------------------- |
| **RFC**      | 0011                                              |
| **Title**    | Weather-Map PNG Pipeline (per-valid-hour layer textures → R2, manifest API) |
| **Status**   | ✅ Completed                                      |
| **Step**     | 7                                                 |
| **Depends on** | RFC-0001 (foundation), RFC-0005 (weather)       |
| **Domain(s)** | feature/weathermap                               |
| **Updated**  | 2026-07-15                                        |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

---

## 1. Summary

A background pipeline that turns raw numerical-weather-model output into
map-ready textures — one PNG per **(model, layer, forecast valid hour)**. On
every new model run, the pipeline reads the layer's fields (wind u/v/gust,
temperature, precipitation, snowfall, …) from Open-Meteo's spatial `.om`
archive via HTTP range reads, encodes each forecast valid hour into an RGBA
PNG, uploads it to R2 **keyed by valid time**, and records the frame in
Postgres. A manifest endpoint lists the available frames per (model, layer) so
the client can animate the next N hours and always fetch the freshest data for
any given wall-clock hour.

Two design choices carry the RFC:

1. **Object keys are valid times, not run times.**
   `weather-map/dwd_icon_d2/wind/2026-07-15T1200Z.png` is "the wind at noon" —
   when a newer model run covers the same hour, the render **overwrites the
   same key**, so a forecast frame naturally converges toward the analysis as
   runs roll in, and clients never chase changing URLs. (File names use the
   compact `T1200Z` form — no colons in object keys.)
2. **Layers are a code registry, not schema.** A layer = which `.om` variables
   feed it + how they pack into PNG channels. Adding a scalar layer
   (cloud cover, humidity, CAPE…) is ONE entry in `layers.ts`; the pipeline
   (due-check, render, keys, manifest, pruning) and the DB row shape are
   layer-generic. All layers of one valid time share a single `.om` reader
   session, so a new layer adds encode work, not HTTP round-trips.

## 2. Motivation & Context

- **Problem.** The iOS map renders wind (heatmap + particles) from a
  **bundled proof-of-concept texture** baked at development time; its
  `OmWindStore` also range-reads Open-Meteo `.om` files directly from the
  device, which fails on the simulator, re-downloads per client, and couples
  the app to a third-party file layout. There is no server-side artifact that
  says "this is the wind at hour X" — and the map's roadmap wants more than
  wind (temperature, precipitation, snow overlays).
- **Background.** The wind texture contract (`wind.png` + scales metadata) was
  designed in the iOS POC (`tools/wind-encoder/generate.py`) precisely so a
  real backend could replace the generator without any client change.
  `tools/wind-encoder/fetch_real.py` proved the source path (Open-Meteo
  `data_spatial` archive). [[../weather-openmeteo-mapping]] and RFC-0005
  established the Open-Meteo integration; RFC-0006 established R2 object
  storage (`packages/object-storage`).
- **Goals.**
  - One PNG per (model, layer, forecast valid hour) in R2, refreshed whenever
    the model publishes a new run; newer runs overwrite older forecasts for
    the same hour.
  - Day-1 layers: **wind, temperature, precipitation, snowfall** — proving
    the generic path; the wind PNG stays byte-for-byte the iOS POC contract.
  - A manifest API the client polls to discover frames (valid time → URL +
    decode scales + bbox + unit + run provenance).
  - A model registry covering the user-selected major models (2026-07-15)
    with per-model enable/disable, driven by cheap "did the run advance?"
    checks — no fixed alignment to publication calendars.
  - Bounded cost: HTTP range reads (only the needed variables out of ~126 per
    file), skip-if-unchanged idempotence.
- **Non-goals.**
  - Serving vector tiles or raster *tiles* (single whole-domain texture per
    frame; the client warps it — same as the POC).
  - Client work: switching iOS off the bundled texture is tracked in the app
    repo (`REMAINING-WORK.md` §9), not here.
  - Derived/styled rasters (color-ramped images) — textures carry raw values;
    ramps live client-side where they can respond to theme/tuning.

## 3. Scope (In / Out)

- **In:** `feature/weathermap` domain (model registry, layer registry,
  repository, service, render task, manifest/catalog routes),
  `packages/om-spatial` (data_spatial client + `.om` reading), PNG encoders
  (wind + scalar), R2 upload + pruning, `weather_map_frame` table.
- **Out:**
  - **ICON-D2 15 min** — the 15-minutely variant is not published on
    `data_spatial` (404); it exists only in the time-series API. Revisit if
    Open-Meteo adds it.
  - ~~**UKMO UKV 2 km**~~ — WAS out (Lambert-Azimuthal projected grid);
    brought in 2026-07-16 (UK/sailing market): `laea-regrid.ts` resamples the
    native LAEA raster onto a regular 0.02° grid before the shared encode
    path (§7), validated r=0.9989 / RMSE 0.23 °C against Open-Meteo's own
    point API on the same file.
  - **BOM ACCESS-G** — was stale (data end 2025-06-30), now absent from
    `data_spatial` entirely (latest.json 404, re-verified 2026-07-16); not
    registered. Wanted for the Australia market when Open-Meteo publishes it.
  - Multi-variable non-wind packings (e.g. wave height + direction) — the
    encoder dispatch supports adding a new `kind`, but no such layer ships
    in this RFC.

## 4. Domain Model & Ubiquitous Language

- **Model** — a numerical weather model as published on Open-Meteo's spatial
  archive, identified by its `data_spatial` id (e.g. `dwd_icon_d2`). The
  registry entry carries label, provider, resolution, and enablement.
- **Layer** — a renderable map variable set with a packing rule. Registry
  (`layers.ts`) entry: public id, label, unit of the decoded values, and a
  `kind`:
  - `wind` — u/v/gust → R/G/B (the special 3-variable case),
  - `scalar` — one `.om` variable → R channel (temperature, precipitation,
    snowfall, and any future single-field layer).
- **Run** — one execution of a model, identified by its **reference time**
  (`reference_time` in `latest.json`). Runs supersede each other.
- **Valid time** — the wall-clock hour a forecast field describes. One run
  yields many valid times; consecutive runs *overlap* on valid times.
- **Frame** — the rendered artifact for (model, layer, valid time): a PNG in
  R2 plus its decode metadata row in Postgres. A frame is **overwritten in
  place** when a newer run covers the same valid time (`runTime` tells which
  run last painted it).
- **Horizon** — how far ahead of "now" the pipeline renders. UNCAPPED by
  design (user decision 2026-07-15): every valid time the run publishes is
  rendered — GFS reaches ~16 days, regionals ~2 days; distant hours arrive at
  the model's own 3/6-hourly granularity. Force-run/CLI can narrow
  per-invocation.
- **Manifest** — the client-facing listing of one (model, layer)'s current
  frames, ordered by valid time.
- **Catalog** — the models + layers listing the client builds its pickers
  from.

Frame lifecycle: `(absent) → rendered(runTime=R1) → overwritten(runTime=R2 >
R1) → pruned` (valid time falls behind the retention cutoff). A layer whose
variable a file lacks (e.g. `snowfall` in summer ICON-EU runs) simply has no
frame for that hour — a **soft skip**, not an error; its manifest stays empty.

## 5. Data Model (Drizzle)

One table, `weather_map_frame` — the manifest's source of truth (we never LIST
R2 to answer queries; same pattern as RFC-0006 where Postgres indexes the blob
store).

| column | type | rationale |
| --- | --- | --- |
| `id` | integer identity PK | house pattern |
| `uid` | text uuid, unique | house pattern (public id, unused in URLs here but kept for consistency) |
| `model` | text | `data_spatial` model id; part of the natural key |
| `layer` | text | layer registry id; part of the natural key — layers are rows, not columns, so new layers never touch the schema |
| `validTime` | timestamptz | the hour this frame describes; part of the natural key |
| `runTime` | timestamptz | reference time of the run that last painted this frame — provenance + freshness ("run 06Z") |
| `objectKey` | text | R2 key (`weather-map/<model>/<layer>/<validTimeISO>.png`); stored, not derived, so key-scheme changes never orphan objects |
| `width`, `height` | integer | texture dimensions |
| `west`, `south`, `east`, `north` | double precision | geographic bbox of the grid (from `latest.json` CRS `BBOX`) |
| `scales` | jsonb `$type<JsonValue>()` | the layer-shaped decode payload — wind: `{uMin,uMax,vMin,vMax,gustMin,gustMax,hasRealGust}`, scalar: `{min,max}`. jsonb because each layer kind packs differently; per-frame because each texture normalizes to its own extremes for full 8-bit precision |
| `renderedAt` | timestamptz | when we painted it (ops/debug) |

- **Unique** `(model, layer, validTime)` — the overwrite-in-place invariant;
  renders upsert on this key. The manifest query
  (`WHERE model = ? AND layer = ? AND validTime >= ? ORDER BY validTime`)
  uses the same index.

Migration: additive (`drizzle/0003_high_randall.sql`), no backfill.

## 6. API Surface (routes + OpenAPI)

Mounted at `/v1/weather-map`, authenticated like every other v1 surface
(anonymous JWT or Clerk).

### `GET /v1/weather-map/models`
The catalog — the client's capability matrix for restricting model/layer
pickers and informing the user:

```jsonc
{ "data": {
    "models": [{
      "model": "dwd_icon_d2", "label": "ICON-D2", "provider": "DWD",
      "resolutionKm": 2.2,
      "layers": ["precipitation", "temperature", "wind"],  // ACTUALLY served
      "coverage": { "west": -3.94, "south": 43.18, "east": 20.34, "north": 58.08 },
      "run": "2026-07-15T06:00:00Z",
      "validThrough": "2026-07-15T22:00:00Z"                // scrubber's end
    }],
    "layers": [{ "layer": "wind", "label": "Wind", "unit": "m/s" }]
} }
```

Per-model `layers`/`coverage`/`run`/`validThrough` are **derived from the
fresh frames** (one slim query), never hand-maintained: which fields a model
returns is empirical — some models lack certain variables entirely, snowfall
is seasonal — so the frame table is the single source of truth and the picker
self-heals as availability changes. The registry contributes only identity
(label/provider/resolution). A model with no frames yet lists `layers: []`
and null coverage.

### `GET /v1/weather-map?model=<id>&layer=<id>`
The manifest. Validation: both ids required and must be registered + active
(`FORM_ERROR` / `WEATHERMAP_UNKNOWN_MODEL` | `WEATHERMAP_UNKNOWN_LAYER`
otherwise).

```jsonc
{
  "data": {
    "model": "dwd_icon_eu",
    "layer": "temperature",
    "unit": "°C",
    "run": "2026-07-15T03:00:00Z",        // newest runTime among frames
    "frames": [
      {
        "validTime": "2026-07-15T09:00:00Z",
        "runTime": "2026-07-15T03:00:00Z",
        "url": "https://…/weather-map/dwd_icon_eu/temperature/2026-07-15T0900Z.png",
        "width": 1377, "height": 657,
        "bbox": { "west": -23.5, "south": 29.5, "east": 62.5, "north": 70.5 },
        "scales": { "min": 1.1, "max": 45.95 }   // layer-shaped (see §7)
      }
    ]
  }
}
```

Frames returned: `validTime >= now - 1h` (the current hour stays listed while
it is in progress), ordered ascending. `url` is
`OBJECT_STORAGE_PUBLIC_BASE_URL + "/" + objectKey` when that env is set
(R2 public bucket / custom domain — the intended production path), else the
proxy route below.

### `GET /v1/weather-map/frames/{model}/{layer}/{file}`
Fallback proxy streaming the PNG from R2 (`Content-Type: image/png`,
`Cache-Control: public, max-age=300`) for environments without a public
bucket URL (local dev). `file` is validated against
`^\d{4}-\d{2}-\d{2}T\d{4}Z\.png$` and the (model, layer, validTime) must exist
in the table — no free-form key access into the bucket (activity tracks share
it).

Response schemas carry `.describe()` + `.meta({ ref:
"WeatherMapCatalogResponse" | "WeatherMapManifestResponse" })`, per house
OpenAPI rules. `scales` is an open `record<string, number|boolean>` in the
schema so new layer kinds never break generated clients.

## 7. Services & Business Logic

`WeatherMapService extends BaseUseCase` (deps: `WeatherMapRepository`,
`SpatialSource` (`OmSpatialClient`), `ObjectStorage`).

Four pipeline entry points (all sharing the private `planModel()` due-check,
so "due" has one definition):

- `planRefresh(now)` — the orchestrator's pass: per model, `latest.json` +
  one frame query → the due list `{ model, referenceTime, dueFrames }[]`.
  No grid reads. Per-model failures collect into `errors`.
- `refreshModelById(modelId, now)` — the fan-out child's pass: renders every
  due frame of ONE model at up to `CHILD_HOUR_CONCURRENCY` concurrent hours
  (adaptive per the model's measured hour bytes, §8). Throws on model-level
  failure (the task retry owns recovery); never prunes.
- `prune(now)` — public; called by the orchestrator each tick and by
  `refresh()` at the end of a full pass.
- `refresh(): Promise<RefreshSummary>` — the full in-process pass (force-run
  task + CLI). For each active model, independently (one model's failure must
  not block others; errors are collected into the summary):
  1. `latest.json` → `referenceTime`, `validTimes`, bbox. Skip the model if
     `completed !== true`.
  2. Select valid times inside the window `[now - 1h, now + HORIZON]`.
  3. One repository query loads every layer's frame state for the window;
     for each valid time, the **due layers** are those with no frame yet or a
     frame whose `runTime < referenceTime` (run advanced → repaint; same run
     → skip). This is the cheap idempotence that lets the task poll every
     15 min while doing real work only when a model publishes. It also makes
     an interrupted run resume naturally — frames upsert one by one.
  4. Per valid time with due layers: open the `.om` ONCE, read the union of
     the due layers' variables, encode each layer (kind dispatch), `put` to
     R2, upsert the frame row. A layer whose variable is absent from the file
     is counted `missingVariable` and skipped — not an error.
  5. Prune: frames with `validTime < now - RETENTION` → delete R2 object +
     row (row only after the object delete succeeded, so failures retry).
- `getCatalog()` / `getManifest(model, layer)` / `getFrameObject(model,
  layer, file)` — thin reads for the routes.

### PNG contract (`services/layer-png.ts`, pure + unit-tested)

Shared rules for every kind: channel byte = `round((value - min) / (max -
min) * 255)` with per-frame extremes; `A = 255` always (alpha is never data);
**row 0 = north** (the `.om` grids are south-origin → flipped during encode);
NaN cells (outside a model's domain) encode as the layer's zero.

- **wind** — `R = u`, `G = v`, `B = gust` (m/s); u/v scales symmetric around
  zero (`uMin = -max|u|`); gust falls back to `hypot(u,v) × 1.35` when the
  file lacks `wind_gusts_10m` (T+0 analysis) — `hasRealGust: false` in
  scales. Byte-for-byte the iOS POC contract.
- **scalar** — `R = value`, `G = B = 0`; `{min, max}` scales. Uniform fields
  (zero precipitation everywhere) get a unit span so decoding stays defined.
- A new packing kind = one encoder here + a case in the service's
  `encodeLayer` dispatch.

### Layer registry (`layers.ts`)

| layer | kind | `.om` variable(s) | unit |
| --- | --- | --- | --- |
| `wind` | wind | `wind_u_component_10m`, `wind_v_component_10m`, `wind_gusts_10m` (opt) | m/s |
| `temperature` | scalar | `temperature_2m` | °C |
| `precipitation` | scalar | `precipitation` | mm |
| `snowfall` | scalar | `snowfall` | cm |

Narrowing is per-invocation only (force-run payload / CLI `--layers`), never
env. Variable availability was verified live (2026-07-15, ICON-EU):
temperature/precipitation/cloud_cover/relative_humidity present; snowfall
absent in the July run → exercised the soft-skip path.

### Model registry (`models.ts`)

Static, code-reviewed list (id → label/provider/resolution/enabled). The
user-chosen set (2026-07-15) plus verified recommendations:

| data_spatial id | label | enabled |
| --- | --- | --- |
| `dwd_icon` | DWD ICON 11 km global | ✅ |
| `dwd_icon_eu` | DWD ICON-EU 6.5 km | ✅ |
| `dwd_icon_d2` | DWD ICON-D2 2.2 km | ✅ |
| `ecmwf_ifs` | ECMWF IFS HRES 9 km | ✅ — ships the native O1280 reduced-Gaussian POINT LIST (`[1 × 6,599,680]`), not a lat/lon raster (encoding it verbatim produced unopenable 6.6M×1 PNGs, found in prod 2026-07-16). `reduced-gaussian.ts` resamples it onto a regular 0.1° grid (3600×1800, nearest-neighbor; layout verified r=0.9999 against the same run's `ecmwf_ifs025`) before the shared encode path. |
| `ecmwf_ifs025` | ECMWF IFS 0.25° | ✅ |
| `geosphere_arome_austria` | GeoSphere AROME 1 km | ✅ |
| `italia_meteo_arpae_icon_2i` | ItaliaMeteo ICON-2I 2.2 km | ✅ |
| `jma_gsm` | JMA GSM 0.5° | ✅ |
| `jma_msm` | JMA MSM 0.05° | ✅ |
| `ncep_gfs013` | NOAA GFS 0.13° | ✅ |
| `meteofrance_arpege_world025` | ARPEGE World 0.25° | ✅ |
| `meteofrance_arpege_europe` | ARPEGE Europe 0.1° | ✅ |
| `meteofrance_arome_france_hd` | AROME France HD 0.01° | ✅ |
| `knmi_harmonie_arome_europe` | KNMI Harmonie 2 km | ✅ |
| `dmi_harmonie_arome_europe` | DMI Harmonie 2 km | ✅ |
| `ncep_hrrr_conus` | NOAA HRRR 3 km | ✅ |
| `metno_nordic_pp` | MET Norway Nordic 1 km | ✅ |
| `meteoswiss_icon_ch1` | MeteoSwiss ICON-CH1 1 km | ✅ |
| `meteoswiss_icon_ch2` | MeteoSwiss ICON-CH2 2 km | ✅ |
| `ukmo_global_deterministic_10km` | UKMO Global 10 km | ✅ — added 2026-07-16 (UK/sailing market). Regular lat/lon 2560×1920; wind ships as speed+direction, covered by the derive-u/v encode path. |
| `ukmo_uk_deterministic_2km` | UKMO UKV 2 km | ✅ — enabled 2026-07-16 (UK/sailing market). NATIVE Lambert-Azimuthal projected raster (zero NaN fringe, r=0.61 vs UKMO global under an equirect assumption); `laea-regrid.ts` resamples onto a regular 0.02° grid (1626×872), frames carry the TARGET raster's bbox. Validated vs the point API: r=0.9989, RMSE 0.23 °C. |

Evaluated and rejected (removed from the registry 2026-07-16, kept here so
nobody re-discovers it): `ncep_gfs025` (GFS 0.25°) — its data_spatial files
carry pressure-level fields only (no 10 m wind / 2 m temp, verified
2026-07-15); GFS 0.13° covers the family. Only relevant again if an upper-air
layer ships.

Wanted but not publishable: `bom_access_global` (BOM ACCESS-G, the Australia
market) is in Open-Meteo's point-forecast API but NOT in the data_spatial
archive (all id variants 404, verified 2026-07-16) — nothing to render until
Open-Meteo publishes it. Australia is meanwhile covered by the global tier
(GFS 0.13°, IFS HRES, ICON, UKMO Global, ARPEGE World).

Narrowing is per-invocation only (force-run payload / CLI `--models`) — dev
renders 1–2 models via the CLI instead of env config. The pipeline's tunables
(horizon, retention, base URL, concurrency) are **design constants in code**,
not env: they are engineering decisions this RFC owns, and an env knob would
just invite config drift between environments.

## 8. Background Jobs (Trigger.dev)

The cron path is a **fan-out**: a lightweight orchestrator decides which
models have due work and spawns one render run per due model, each on its own
machine (design revised 2026-07-15; the original single-task monolith is in
§14).

### `weathermap-orchestrate` (scheduler)

`schedules.task`, cron `*/15 * * * *`, `maxDuration` 300,
`concurrencyLimit: 1` (overlapping ticks never double-plan). Standard trigger
scaffold, then:

1. `weatherMapService.planRefresh()` — per enabled model, one `latest.json`
   GET + one frame query compute the due (layer, valid time) set. **No grid
   reads, no rendering** — the plan pass costs seconds. Due-ness is the same
   `runTime < referenceTime` check the render path uses (shared
   `planModel()`), so the two can never disagree.
2. Models with due work → `weathermapRenderModelTask.batchTrigger`, one child
   per model, with a **global-scoped idempotency key**
   `weathermap-render-<model>-<referenceTime>` + `idempotencyKeyTTL: "1h"`:
   re-ticks while a child is still rendering the same run dedupe to the
   in-flight run (no pile-up during a slow backfill); after the TTL an
   incomplete render is re-fanned and resumes (frames upsert one by one).
   Children are tagged `model:<id>` for dashboard filtering.
3. `prune()` — pruning is the orchestrator's job; children never prune.

Per-model plan failures are captured to tracking (with `{ model }` context)
without failing the tick.

### `weathermap-render-model` (fan-out child)

`schemaTask`, payload `{ model }`, `machine: "medium-1x"` — the cost-optimal
preset: same per-second price as small-2x (which OOM-killed in prod
2026-07-16 — global models hold ~120 MB of grids per in-flight hour plus
encode buffers) while its 2 GB funds 4 concurrent hours; the ~12 min
long-horizon runs are attacked with parallelism, not a 2×-price medium-2x
whose second vCPU can't speed the single-threaded JS packing loops. Revisit
against the run output's `profile` ratios (§11). `maxDuration` 3600,
`retry.maxAttempts: 3`, `queue.concurrencyLimit: 10`. Calls
`weatherMapService.refreshModelById(model)`: re-reads `latest.json` (if the
run advanced since planning, the child renders the newer one) and renders
every due frame of that one model, with up to **`CHILD_HOUR_CONCURRENCY =
4`** valid hours in flight — ADAPTIVE per model (2026-07-16): the first hour
renders alone and its measured grid bytes decide how many of the remaining
hours fit the memory budget (`adaptiveHourConcurrency`: 1.4 GB budget ÷
(measured bytes × 2.0 safety + 150 MB fixed per-hour overhead — the reader's
64 MB wasm heap + encode buffers)). The safety is 2.0 because the OOM killer
sees RSS, not live bytes: freed grid pages return to the OS lazily, and the
first calibration (×1.3, live-bytes thinking) still OOM-killed `ecmwf_ifs`.
An hour's weight varies ~3× across models (regional ~100 MB vs `ecmwf_ifs`
~300 MB with its regrid copies): regionals keep 4, UKMO global gets 3,
`ecmwf_ifs` renders sequentially — slower beats OOM-killed on the 2 GB
machine. Consumed layer grids are dropped as soon as their layer encodes,
trimming the peak further.

- The queue limit bounds how many models render at once **across machines** —
  every child hits the same Open-Meteo archive host, so it is a rate-limit
  knob, not a memory one (memory is per-machine now).
- Model-level errors throw → the task's retry owns recovery (there are no
  sibling models to isolate inside a child). An unknown/disabled model aborts
  without retrying (`AbortTaskRunError` — the registry changed under a queued
  run).
- A child that dies mid-backfill resumes on retry / next orchestration via
  the per-frame upsert, exactly like the old monolith's tick-resume.

Why 15-min polling instead of aligning to publication calendars: the
"run advanced?" check is one small `latest.json` GET per model (≈20 requests),
and `runTime < referenceTime` makes child runs exactly as frequent as the
models themselves update (hourly for ICON-D2/KNMI/HRRR/Nordic, ~3 h ICON-EU,
~6 h globals) — most ticks fan out 0–3 children. A calendar would save nothing
and add drift risk when providers shift publication times.

### Force-run (manual task + CLI)

Both run the full **in-process** pass `refresh(now, overrides)` (models
through a bounded pool, hours sequential — unlike the cron path, which fans
out) and share the run-advance idempotence — so a force-run after unchanged
runs is a cheap no-op unless narrowed; overrides can only select within the
enabled registry.

- **`weathermap-render-now`** (`schemaTask`, payload
  `{ models?, layers?, horizonHours? }`, `{}` = one full cron-equivalent
  pass): trigger from the Trigger.dev dashboard or `tasks.trigger` when the
  worker is deployed/running. `machine: "medium-1x"` — the in-process pass
  holds up to `MODEL_CONCURRENCY` (4) models' grids at once (~100 MB each),
  which overruns the 0.5 GB default machine.
- **`npm run weathermap:render`** (`tools/weathermap-render.ts`) — terminal
  force-run with no Trigger dependency:
  `npm run weathermap:render -- --models=dwd_icon_eu --layers=wind,temperature --horizon=3`.
  Verified live: a never-rendered slice (ICON-D2 precipitation, 1 h horizon)
  rendered 2 frames in 4.8 s; an already-current slice no-opped in 2.1 s.

## 9. Dependencies & Integrations

- **`@openmeteo/file-reader`** (WASM `.om` reader; official Open-Meteo
  package). Used with `OmHttpBackend` → HTTP **range reads**: only the needed
  variables are fetched out of ~126 in each file (whole files are 8–43 MB;
  full-file download across models × hours would be GBs per run — §14).
  **Library gotchas handled** (all found under whole-registry load,
  2026-07-15):
  1. `getChildByName` scans children metadata *sequentially* over HTTP
     (~15 s for a late name, a full scan for a missing one) →
     `OmSpatialClient` enumerates all children **by index** once per file and
     resolves names from that map. Enumeration is chunked (24 in flight) —
     unbounded fan-out over 300+-child files × concurrent models was a
     connection storm.
  2. The library's shared wasm singleton has a **fixed-size Emscripten heap**
     (growth disabled): whole-registry renders first fragment it
     (`memory access out of bounds` on later big grids) and eventually abort
     it (`RuntimeError: Aborted(OOM)`), poisoning every read for the rest of
     the process. → a **fresh wasm instance per `.om` file** (the heap dies
     with the reader; V8 caches the compiled module so it costs ~3 ms),
     duplicating the library's unexported module wrapper (revisit on
     dependency bumps). A process-wide semaphore (`READ_CONCURRENCY = 2`)
     bounds resident memory across instances.
  3. Wind naming differs per model: GeoSphere/ItaliaMeteo/KNMI/DMI/MET Norway
     publish `wind_speed_10m` + `wind_direction_10m` instead of u/v
     components → the encoder derives u/v (`u = -speed·sin θ`,
     `v = -speed·cos θ`, meteorological FROM-direction).
- **`pngjs`** — pure-JS PNG encode.
- **Trigger.dev deploy note:** `@openmeteo/file-reader` loads a bundled
  `.wasm` module at runtime. `trigger:dev` resolves it from `node_modules`;
  when the first cloud deploy happens, verify the wasm asset survives
  bundling (add it to `trigger.config.ts` `additionalFiles`/externals if the
  build strips it).
- **Open-Meteo `data_spatial`** (`https://map-tiles.open-meteo.com/data_spatial/
  <model>/latest.json` and `<model>/<yyyy>/<mm>/<dd>/<HHMM>Z/<valid>.om`).
  Quirk handled in the client: `latest.json` embeds raw newlines inside
  `crs_wkt` (invalid strict JSON) — control characters are stripped before
  parsing. bbox comes from the `BBOX[south,west,north,east]` clause of
  `crs_wkt`. Attribution "Weather data by Open-Meteo.com" (same as RFC-0005).
- **R2 via `packages/object-storage`** (existing port; no changes). New env:
  `OBJECT_STORAGE_PUBLIC_BASE_URL` (optional) for public frame URLs.

## 10. Security & Privacy

No user data anywhere in the pipeline. Catalog/manifest/proxy routes require
auth (house default); the proxy validates model + layer against the registry
and `file` against a strict pattern + the DB before touching the bucket, so it
cannot be used to read arbitrary keys (activity tracks live in the same bucket
under `activities/`).

## 11. Observability

- Orchestrator log per tick: models checked / due list (model + run + due
  frame count) / plan errors / pruned. Each child run logs its own summary
  (rendered / missingVariable / missingByLayer — the misses named per layer,
  e.g. `{ snowfall: 117 }` / frameErrors / layerStats / profile) and is
  tagged `model:<id>` — per-model history is one dashboard filter.
- `profile` is the run output's own profiler (2026-07-16, for the cost
  story): cumulative ms per phase — fetchGridsMs (archive range reads),
  regridMs (reduced-Gaussian + LAEA JS resampling), packMs (single-threaded
  JS: u/v derivation + channel packing — the Rust/napi candidate), webpMs
  (native libvips/libwebp compression — tuned via WEBP_EFFORT/vCPUs, never a
  rewrite), uploadMs + uploadedBytes (R2 puts; bytes size the effort
  trade-off), dbMs (frame find/upsert), wallMs (the model render's real
  elapsed time). Phase totals are summed across concurrently-rendering
  hours, so they exceed wallMs — read the ratios to see where task-seconds
  (= Trigger spend) go before tuning machines/concurrency further. The
  memory trio — hourGridBytes (heaviest measured hour), hourConcurrency
  (what the adaptive formula chose), maxRssBytes (peak process RSS) — is the
  data for machine-size decisions. First prod readings (2026-07-16):
  webpMs ≈ 71–78% of task-seconds, packMs ≈ 4–6% — the pipeline is
  compression-bound (a Rust rewrite of the JS side would cap out at ~5%;
  WEBP_EFFORT is the real CPU lever, deliberately kept at 4 for frame size).
- `Tracking.captureException` per failing model with `{ model }` context so
  one broken feed pages without hiding the other 19 (plan errors in the
  orchestrator; render errors in the failing child only).
- Frame rows carry `renderedAt` + `runTime` — staleness is queryable.

## 12. Performance & Scalability

Parallelism operates at three levels; bounds are deliberate:

- **Across models** — the cron path fans out one Trigger.dev run per due
  model, so models parallelize across MACHINES; `queue.concurrencyLimit: 10`
  on the child bounds simultaneous renders because every child range-reads
  the same archive host (a rate-limit bound — memory is per-machine). The
  in-process paths (`planRefresh`, and `refresh` for force-run/CLI) use a
  bounded pool (`MODEL_CONCURRENCY = 4`), not `Promise.all` over all 20:
  in `refresh` each in-flight model holds its current hour's grids in memory
  (~100 MB for a global 0.13° hour). Error isolation is preserved everywhere
  (plan/summary errors fold per model; a child failure touches one model).
- **Within a file** — variables read concurrently over one reader (verified
  byte-identical vs sequential; 2.5 s → 0.8 s for 5 ICON-EU variables), and
  child enumeration is parallel-by-index (~0.6 s vs ~15 s sequential
  `getChildByName` scans).
- **Valid times within a model** — up to `CHILD_HOUR_CONCURRENCY = 4` in a
  fan-out child (a whole machine to itself), chosen ADAPTIVELY per model
  from the first hour's measured grid bytes (§8) so heavy models trade
  parallelism for fitting the machine;
  sequential in the in-process `refresh`, which already runs 4 models in one
  process. One valid time failing (transient archive error) is retried once
  and then skipped in isolation (`frameErrors` in the summary) — a later
  pass picks the hour up again; it never fails the whole model.

Measured live (pre-fan-out, in-process): 3 fresh models × 2 layers × 2–3
hours rendered in 13.6 s wall-clock. Steady state per 15-min tick: 20
`latest.json` GETs + 20 frame queries in the orchestrator; children spawn
only when a run advanced (hourly regionals, ~6 h globals → typically 0–3 per
tick). A cold start fans out every model at once, 6 rendering concurrently;
child `maxDuration` 3600 covers the longest single-model backfill, and an
interrupted child resumes on retry / next orchestration (per-frame upsert).
Concurrent producers (two children of consecutive runs, or a child + a
force-run) are safe: frames upsert key-stably and `runTime` only moves
forward.
- R2 storage is bounded by the models' own horizons:
  `frames ≤ Σ(model valid times) × layers` ≈ 1 300 × 4 ≈ 5 000 objects,
  overwritten in place; past hours prune after 1 h. Cold-start backfill of
  the full horizons exceeds one task window — the per-frame upsert makes
  successive ticks resume where the previous one stopped, and steady state
  only re-renders runs that advanced.
- The largest encode (UKMO Global 10 km, 2560×1920) is ~20 MB RGBA in memory
  (GFS 0.13°, 2879×1441, is ~16 MB) — fine for the worker.

## 13. Testing Strategy

- `layer-png.spec.ts` — encoder math per kind: channel scaling round-trip,
  symmetric u/v scales, gust fallback, north-flip, alpha=255, NaN handling,
  negative scalar ranges (temperature), uniform-field guard (zero
  precipitation), size/shape mismatch rejection.
- `weathermap.service.spec.ts` — mocked repository/source/storage:
  - renders every layer × horizon hour from scratch; single `fetchGrids`
    call per valid time with the union of variables.
  - skips when `runTime === referenceTime`; repaints only stale layers (and
    only reads their variables); horizon filtering; `completed: false` skip.
  - missing-variable soft skip (snowfall) counted, not errored.
  - layer narrowing via config; per-model error isolation; pruning
    (object-first, row kept on delete failure).
  - catalog shape; manifest (proxy vs public URL, unknown model/layer);
    frame proxy (happy + 404); file-name round-trip.
- No network in tests; `SpatialSource` is a port with an in-memory fake.

## 14. Alternatives Considered

- **Full-file `.om` download (as the POC did)** — rejected: GFS 0.13° alone is
  38 MB × 200+ valid times; range reads fetch only the needed variables.
- **Key by run time (`…/06Z/12:00.png`)** — rejected: clients would need to
  resolve "which run is newest" before every fetch, URLs churn every run, and
  stale-run frames linger. Valid-time keys give one stable URL per hour whose
  content improves as runs roll in (the user's core requirement).
- **A layer enum / per-layer columns in the DB** — rejected: layers as text
  rows + jsonb scales mean a new layer is a registry entry with zero schema
  churn (the user's extensibility requirement).
- **One multi-layer PNG (pack temperature into the wind texture's spare
  bits)** — rejected: layers update/ship independently, clients fetch only
  what they show, and the wind PNG must stay byte-compatible with the iOS POC.
- **Store PNGs in Postgres** — rejected: RFC-0006 already established R2 for
  binary blobs; frames are up to ~3.7 MB each.
- **Render on demand (lazy, per request)** — rejected: first-viewer pays a
  multi-second render; the map needs the full frame strip for animation; and
  demand-driven rendering can't pre-warm the "next hour" before it arrives.
- **A separate scheduler per model matched to its publication calendar** —
  rejected (§8): more moving parts for zero savings over cheap polling.
- **One monolithic render task (the original §8 design)** — superseded
  2026-07-15 by the orchestrator + per-model fan-out: in one process, model
  concurrency was memory-capped at 4 and hours had to stay sequential, so a
  slow model/backfill blocked the rest and cold starts spanned many ticks.
  Fan-out gives each model its own machine, retries, and log trail. The
  in-process pass survives as the force-run/CLI path, where narrowed dev
  slices don't warrant spawning cloud runs.
- **Fanning out per (model, hour-chunk) instead of per model** — deferred:
  more runs and orchestration for marginal gain today. If one model's horizon
  ever outgrows a single child, the orchestrator can split the same child
  task over hour ranges (the payload/idempotency scheme leaves room).
- **`sharp` for PNG encode** — rejected: native binary complicates the
  Trigger.dev deploy; `pngjs` is fast enough at these sizes.

## 15. Implementation Plan (checklist)

- [x] Probe `data_spatial` availability + grid types for the model set;
      verify layer variables (temperature/precipitation present; snowfall
      seasonal; cloud_cover/humidity available for future layers)
- [x] Spike `@openmeteo/file-reader` range reads in Node; found + fixed the
      sequential `getChildByName` scan (parallel indexed enumeration)
- [x] `packages/om-spatial` — latest.json + variable-agnostic grid client
- [x] `weather_map_frame` schema + migration (`0003_high_randall.sql`)
- [x] `feature/weathermap` domain: errors, models + **layers** registries,
      schemas, repository, `layer-png.ts` (wind + scalar encoders), service
      (+spec), module, routes, container + `/v1/weather-map` mount
- [x] `weathermap-render` Trigger task
- [x] Fan-out rework (2026-07-15): `weathermap-orchestrate` +
      `weathermap-render-model` tasks, `planRefresh`/`refreshModelById`/
      public `prune` service entry points, per-child hour concurrency
- [x] Lint suite + tests green; convention-reviewer pass
- [x] E2E verified against the real archive + R2 (dwd_icon_eu: wind +
      temperature + precipitation rendered for the 3 h test horizon,
      snowfall soft-skipped as expected, idempotent re-run, interrupted-run
      resume observed; decoded PNGs physically plausible — 7.7 m/s northerly
      at Alaçatı, 28.4 °C İstanbul at 09Z)
- [ ] iOS follow-up tracked in app repo (switch `OmWindStore` to manifest)

## 16. Open Questions & Resolved Decisions

- **Resolved — retention:** 1 h (`RETENTION_HOURS = 1`, design constant;
  user decision 2026-07-15) — frames prune exactly when they leave the
  manifest window; no look-back scrubbing.
- **Resolved — horizon:** uncapped (user decision 2026-07-15) — the run's own
  horizon is the horizon; the map can scrub as far as the model goes.
- **Resolved — no env tunables:** horizon/retention/base-URL/concurrency are
  engineering decisions this RFC owns, hardcoded as constants; per-invocation
  narrowing (force-run payload / CLI flags) covers dev needs. Only genuinely
  deployment-specific config (`OBJECT_STORAGE_PUBLIC_BASE_URL`) lives in env.
- **Resolved — one PNG per (model, layer), whole domain** (no tiling):
  matches the client's single-texture renderer; the largest frame (~3.7 MB,
  UKMO Global wind, measured live 2026-07-16) is acceptable over the wire. Revisit with tiles only if we add global
  pan-anywhere UX at high zoom.
- **Resolved — scalar precision:** 8-bit per channel with per-frame min/max
  is enough for map visualization (temperature resolves to ~0.2 °C over a
  45 °C span). If a future layer needs more, a 16-bit R+G packing is a new
  `kind`, not a schema change.
- **Resolved — cron fan-out (2026-07-15):** the scheduled path is an
  orchestrator (`planRefresh` → `batchTrigger` one child per due model →
  `prune`) instead of one monolithic render run. Idempotency: global-scoped
  `(model, referenceTime)` key with 1 h TTL — dedupes while a child works a
  run, re-fans an incomplete render afterwards. Child knobs are design
  constants like everything else: `machine medium-1x` (small-2x price, 2 GB
  — small-2x OOM-killed in prod 2026-07-16; the ~12 min long-horizon runs
  are attacked with hour-parallelism, not a 2×-price machine),
  `maxDuration 3600`, `queue.concurrencyLimit 10` (archive-host rate bound),
  `CHILD_HOUR_CONCURRENCY 4` (a CAP — effective concurrency adapts to the
  model's measured hour bytes, §8). Per-run machine overrides
  (`trigger(..., { machine })`) stay an OPTIONAL future speed knob for a
  heavy model whose adaptive (lower) concurrency proves too slow — decide
  from the profile's `hourGridBytes`/`maxRssBytes`, never preemptively.
- **Open — perpetually-due missing variables:** a layer whose variable a
  model never publishes (e.g. snowfall in summer) has no frame row, so its
  hours stay "due" and every tick fans out a child that range-reads and
  renders nothing. Pre-dates the fan-out (the monolith re-read those grids
  every tick too), but fan-out makes it visible as recurring child runs. Fix
  candidate: record missing (model, layer, run) markers (nullable-objectKey
  rows or a side table) so `planModel` stops counting them due until the run
  advances.
- **Open — public bucket URL:** production should set
  `OBJECT_STORAGE_PUBLIC_BASE_URL` (R2 public bucket / custom domain + CDN);
  until then the proxy route serves frames. Decide the domain when deploying.
- **Open — 15-min frames (ICON-D2 15min):** blocked on Open-Meteo publishing
  it to `data_spatial`.

## 17. References

- iOS POC contract: `../nortada-app-ios/tools/wind-encoder/generate.py` (format),
  `fetch_real.py` (source path proof)
- Open-Meteo spatial archive: `https://map-tiles.open-meteo.com/data_spatial/`
- Model update meta: `https://api.open-meteo.com/data/<model>/static/meta.json`
- `@openmeteo/file-reader` — official WASM reader
- RFC-0005 (weather), RFC-0006 (object storage), app repo `REMAINING-WORK.md`
  backend §4
