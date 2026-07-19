# 0008 — Windows are daylight-bound; sailing is exempt

- **Status:** accepted
- **Date:** 2026-07-18
- **Scope:** nortada-backend (`bestWindow`; briefing goodLater/state by extension)

## Context

`bestWindow` counted every go-hour, so wind arriving at 22:00 produced a
"22:00–02:00" window and the briefing happily pointed a rider at the middle of
the night. Nobody windsurfs or kites in the dark: you can't read gusts on
black water, kite lines are invisible, self-rescue and shore rescue are
effectively off, and night kiting is outright banned on many beaches. Rare
full-moon/LED sessions are stunts, not something a forecast app should plan.
Night sailing, however, is a legitimate discipline (offshore racing,
deliveries, license night-hours training).

## Decision

Daylight is a WINDOW FILTER, never a verdict parameter (the ADR-0006 rule
stands: strength decides). Each sport's threshold row carries
`daylightBound`; for bound sports an hour outside [sunrise, sunset) cannot
join a window — a run that hits dusk ends there, and night go-hours form no
window of their own. Sailing is exempt (`daylightBound: false`); every other
sport, including the flat-water set, is bound.

Mechanics: the weather service derives a per-hour mask from the forecast's
daily sunrise/sunset (both ISO UTC, plain epoch interval checks) and passes it
to `bestWindow` for both the 48 h conditions window and the per-day outlook
windows. A missing mask or missing sunrise/sunset fails OPEN — daylight may
only ever remove hours, never invent a blocker.

Hourly verdicts, daily headline decisions, ranking, and reasons are untouched:
a nuking 02:00 still shows as "go" in the hour table; it just can't be the
window the app tells you to plan around.

## Consequences

- "goodLater" briefings can no longer point at night; a day whose only
  rideable wind is nocturnal honestly reports no window.
- No API shape change (windows just get scarcer/truncated) — no client regen
  needed.
- If we later want first/last-light generosity (civil twilight ~25 min each
  side), the dial is the mask derivation in one place, not the sports table.
