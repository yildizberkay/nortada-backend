# 0004 — Spot forecasts follow Open-Meteo's best_match

- **Status:** accepted
- **Date:** 2026-07-16
- **Scope:** nortada-backend (freshness contract change visible in nortada-app-ios)

## Context

Spot detail forecasts were pinned to `icon_seamless` so the served payload
matched the ICON model-metadata behind the "model run / updated Xm ago"
freshness story. But spots are not Aegean-only: a UK spot pinned to ICON
gets a coarser forecast than the UKMO 2 km model Open-Meteo would pick for
it. The product owner chose per-location quality over single-model
provenance ("şimdilik best match'ten gelsin").

## Options considered

1. **Keep the `icon_seamless` pin** — consistent provenance, but knowably
   worse forecasts outside ICON-EU's sweet spot.
2. **Pin per region ourselves** — duplicates Open-Meteo's own best-model
   routing; a maintenance treadmill for zero user value.
3. **`best_match`** — the finest local model everywhere; costs the single
   model-run claim.

## Decision

`FORECAST_MODEL = "best_match"`. Freshness stops claiming a model run
(`modelRun: null` — a composite has no single run) and labels the model
"Best match"; clients use `fetchedAt` for their "updated" line. The ICON
member metas remain ONLY as the stale-flag's update-cadence proxy.

## Evidence

- The pin's original rationale was freshness-consistency, not forecast
  quality (comment at `src/packages/open-meteo/index.ts`, 2026-07-16).
- `best_match` composites have no `/data/<model>/static/meta.json`
  (verified 2026-07-16: composite meta paths 404), so an honest per-run
  freshness for it is impossible — the claim had to go, not be faked.

## Consequences

- Better wind numbers wherever a regional model beats ICON (UK, US, …).
- The footnote can no longer say which model produced the numbers, and the
  spot-detail model may differ from the map's user-pinned wind model.
- `modelRun` stays in the API contract as an always-null field until a
  per-location model attribution exists.

## Revisit when

Users need model attribution per spot (e.g. to compare with the map's
pinned model), or Open-Meteo exposes which model `best_match` resolved to —
then serve that instead of dropping the claim.
