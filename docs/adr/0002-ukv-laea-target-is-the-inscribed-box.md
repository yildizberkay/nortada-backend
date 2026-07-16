# 0002 — UKV's LAEA target raster is the inscribed box

- **Status:** accepted
- **Date:** 2026-07-16
- **Scope:** nortada-backend (regrid) — interacts with the app's finest-covering-model pick

## Context

UKMO publishes UKV 2 km as a native Lambert-Azimuthal-Equal-Area raster;
we resample it onto the regular lat/lon grid every consumer assumes. The
first target covered the projected domain's lat/lon ENVELOPE — whose corners
(14.7% of cells) lie outside the source. Out-of-domain wind encodes as
u=v=gust=0, and the client picks the finest model whose bbox covers the
viewport: users over e.g. Biscay saw fabricated dead calm from UKV while
ICON-EU had real wind.

## Options considered

1. **Keep the envelope, NaN→calm** — ships fake data inside a bbox the
   client trusts; violates the product's core honesty rule.
2. **"No data" sentinel (alpha=0) + client support** — correct long-term,
   but a client-visible contract change (alpha is currently never data).
3. **Inscribe the target box in the projected domain** — zero fake cells,
   zero client change; loses the fringe to coarser REAL data. Chosen.

## Decision

The target raster is the largest lat/lon box inscribed in the projected
domain: `W -17.24 S 45.56 E 9.24 N 62.28` (1324×836 @ 0.02°). `regridLaea`
now THROWS on any out-of-domain target cell — a drifted spec fails the hour
loudly instead of shipping fabricated calm.

## Evidence

- Numerically maximized box, then full-grid verified with the exact
  production index-map predicate: 0 out-of-domain cells in 1.1M.
- Shetland, Orkney, west-Ireland waters, Brest and Bergen all remain
  UKV-served; only the strip south of 45.56°N falls back to ICON-EU /
  UKMO-global.
- Specs pin both guarantees (every cell real; the old envelope box rejected).

## Consequences

- The trimmed fringe gets coarser (but real) data.
- Every future LAEA model must ship an inscribed target; the throw enforces it.

## Revisit when

The alpha=0 "no data" sentinel lands in the frame contract (RFC-0011
follow-up) — then envelope targets become safe and the fringe returns.
