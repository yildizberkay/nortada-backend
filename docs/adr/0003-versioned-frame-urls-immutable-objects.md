# 0003 — Frame URLs carry the run version; objects are immutable

- **Status:** accepted
- **Date:** 2026-07-16
- **Scope:** nortada-backend (manifest/upload) · CDN — no app change needed

## Context

Frames repaint IN PLACE: a newer model run overwrites the same object key so
the manifest URL converges to the freshest forecast. That makes the bare URL
cacheable-stale by design — the CDN edge and the client's URLSession kept
serving the old run's bytes after a repaint.

## Options considered

1. **CDN invalidation on repaint** — an API call per frame per run, another
   failure mode, and does nothing for client-side caches.
2. **Short TTLs everywhere** — trades staleness for cache misses on every
   view; still wrong within the TTL window.
3. **Version the URL with the run stamp** — `?v=<runTime epoch>`; a repaint
   mints a DIFFERENT URL, so every cache in the chain misses exactly once.
   Chosen.

## Decision

Manifest frame URLs append `?v=<runTime>`. Because the bytes behind any one
versioned URL never change, objects upload with
`Cache-Control: public, max-age=31536000, immutable` — no invalidation is
ever needed. The client needed NO change (it already keys frames by
validTime+runTime and fetches whatever URL the manifest hands it); the dev
proxy keeps a short TTL since versionless legacy URLs can still reach it.

## Evidence

Manifest already carried `runTime` per frame — the version is derived, not
new state. Specs assert the versioned URL on both the proxy and CDN paths.

## Consequences

- Repaints propagate at manifest speed; zero stale frames.
- Superseded objects are deleted on key change (rows are the bucket's only
  index), so versioning adds no storage growth.

## Revisit when

Never, structurally — this is the standard content-addressed-cache pattern.
