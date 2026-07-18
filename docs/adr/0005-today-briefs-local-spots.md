# 0005 — Today briefs local spots; sport is a lens, not a gate

- **Status:** accepted
- **Date:** 2026-07-17
- **Scope:** nortada-backend (drives nortada-app-ios Today)

## Context

Today's briefing gated its candidate pool two ways that both hurt the target
user (windsurf / wing / kite / sailing). First, `listCandidateSpots` kept only
spots whose `supportedSports` included the briefed sport, and `resolveSport`
threw `UNSUPPORTED_SPORT` for any mismatch — but `supportedSports` is
OSM-sourced and sparse, so a real spot tagged only `sailing` (or untagged →
`["other"]`) was silently dropped from a windsurfer's Today even when it was
firing. Second, favorites were pooled globally: a spot 350 km away could
headline "today's call," which is what the map is for, not Today.

## Options considered

1. **Keep the sport gate, fix curation first** — the tags are the problem;
   gating on them can't be right until they're good, which is open-ended.
2. **Relax the gate only inside the briefing path** — leaves the direct
   conditions endpoint still throwing, so Today could recommend a spot that
   errors when opened. Inconsistent.
3. **Sport is a lens everywhere; localize the pool** — chosen.

## Decision

Sport stops gating anything and becomes purely a scoring lens (it only picks
the threshold table; it never changes which forecast is fetched):
`resolveSport` returns the requested sport instead of throwing, and the
briefing no longer filters the pool by sport. The pool is instead scoped to a
local radius — favorites within `LOCAL_RADIUS_KM` (75 km) of the request's
location; with no location we can't localize, so all favorites stay. Ranking
keeps decision severity as a hard safety gate, then orders within a tier by a
combined score: `quality * (0.55 + 0.45 * proximity)`, where `quality` is
ideal-band closeness weighted by confidence and `proximity = 1/(1 + d/15km)`.
Wind stays dominant (proximity modulates ±45 %); a dead-but-close spot can't
outrank a firing one, and between comparable spots the nearer wins. Soonest
best window is the final tiebreak.

## Evidence

`briefing.service.spec` + `weather.service.spec`: 23 passing, including new
cases — a `sup`-tagged favorite is now briefed (not dropped) for a windsurf
request; a favorite ~370 km away is excluded when a location is sent and never
fetched; `getConditions` scores an untagged spot for the requested sport
instead of throwing. `tsc` (check config) and Biome clean.

## Consequences

- Today surfaces the genuinely-best nearby spot for the user's sport, immune
  to missing/wrong sport tags. Curation quality stops being load-bearing here.
- The direct conditions/forecast endpoint also no longer 400s on an untagged
  sport — one consistent behavior (a recommended spot always opens).
- Far favorites drop off Today entirely (no soft tail); if nothing is within
  the radius the client shows a "no spots near you — explore the map" state.
  A firing favorite just outside 75 km is missed on Today by design.
- `supportedSports` is now display metadata only, not control flow.

## Revisit when

Spot curation becomes trustworthy enough to *inform* (not gate) ranking (e.g.
down-weight a sport a spot genuinely can't host), or the product wants a
"reachable today" radius that varies by user/travel rather than a fixed 75 km.
