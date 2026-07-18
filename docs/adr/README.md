# Architecture Decision Records — nortada-backend

Numbered, immutable records of decisions that shaped the backend — the
"why" that code comments and commit messages can't carry alone. When a
decision gets reversed, the old ADR is never edited or deleted: a new ADR
supersedes it and both stay in the log (the reversal is itself knowledge).

## ADR vs RFC (this repo has both)

- `docs/rfc` — upfront DESIGN of a feature/system, written before building.
- `docs/adr` — DECISIONS with their evidence, usually written at the moment
  a choice was made or reversed. An RFC may spawn several ADRs as its
  design meets reality.

## Which repo does an ADR live in?

- **Backend decisions** (pipelines, storage, API/contract design — even
  when the app is affected) → HERE.
- **App/product-side decisions** → `nortada-app-ios/docs/adr`.
  Cross-reference by repo-qualified number when needed.

## When to write one

Write an ADR when a decision (a) was expensive to reach — experiments run,
alternatives rejected, a revert taken — or (b) constrains future work in a
non-obvious way. Routine implementation choices don't get one.

## Format

MADR-lite with two additions that fit how decisions actually get made here:
**Evidence** (what was tested and what it showed — measurements, verified
external behavior, spec/test anchors) and **Revisit when** (the concrete
condition that would invalidate the decision). Copy `template.md`. Keep it
under a page.

## Conventions

- File name: `NNNN-kebab-case-title.md`, numbered sequentially per repo.
- Title is a statement ("X is Y"), not a topic.
- Status: `accepted` · `superseded by NNNN` (set on the OLD record).
- Index every ADR below.

## Index

- [0001 — Weather-map frames are lossless WebP](0001-weather-map-frames-are-lossless-webp.md)
- [0002 — UKV's LAEA target raster is the inscribed box](0002-ukv-laea-target-is-the-inscribed-box.md)
- [0003 — Frame URLs carry the run version; objects are immutable](0003-versioned-frame-urls-immutable-objects.md)
- [0004 — Spot forecasts follow Open-Meteo's best_match](0004-spot-forecasts-follow-best-match.md)
