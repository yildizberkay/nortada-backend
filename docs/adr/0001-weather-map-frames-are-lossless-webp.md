# 0001 — Weather-map frames are lossless WebP

- **Status:** accepted
- **Date:** 2026-07-16
- **Scope:** nortada-backend (encoder) — contract consumed by nortada-app-ios (ImageIO decode)

## Context

Weather-map frames are DATA textures (R=u, G=v, B=gust, per-frame decode
scales in the manifest) — one wrong byte corrupts wind. The PNG pipeline
(pngjs, pure JS) hit its ceiling on high-resolution regional models: encode
time and file size stopped scaling.

## Options considered

1. **Keep PNG, swap encoder to libvips** — faster, but files stay ~30% larger
   and none of the container limits move.
2. **Lossy WebP/AVIF** — smaller still, but ANY loss corrupts the data
   channels; disqualified by definition.
3. **Lossless WebP (VP8L), 8-bit RGBA** — smaller AND faster via libvips,
   byte-exact. Chosen.

## Decision

Frames are encoded as lossless WebP via sharp (`{lossless: true, effort: 4}`),
uploaded as `image/webp` under `.webp` keys. The packing contract (channels,
scales, north-first rows, A=255) is unchanged. iOS decodes via ImageIO, which
sniffs the container — PNG-era frames still decode during any transition.

## Evidence

- Backend spec round-trips a noisy 16×16 field byte-for-byte and asserts the
  VP8L chunk (a lossy regression fails the suite).
- iOS `WindFrameDecodeTests` decodes a fixture produced by the REAL backend
  encoder and matches all ground-truth bytes — catches color management,
  premultiplication, or a lossy container.
- sharp inside Trigger uses the brandscale-backend recipe: dynamic
  `await import("sharp")` (never in the static graph) + `build.external`.

## Consequences

- ~25–40% smaller frames, faster encodes; no client change was needed.
- WebP's hard 16383 px/side container limit — encoder guards loudly; the
  largest grid today is 3600×1800.
- Transfer shrank but decoded RAM did not (w×h×4 on device) — the real
  ceiling for ever-bigger grids is client memory, not the container.
- One-time purge of `.png` objects/rows at deploy (temporary CLI tool).

## Revisit when

A model needs >16383 px per side (tile or downsample), or client RAM makes
whole-grid frames untenable (move to tiled/pyramid serving).
