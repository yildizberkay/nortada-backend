# 0006 — Wind strength is the only verdict parameter; direction is advisory-only

- **Status:** accepted
- **Date:** 2026-07-18
- **Scope:** nortada-backend (drives every Go/Watch/Skip surface in nortada-app-ios)

## Context

`computeDecision` treated an offshore shore side as a verdict modifier: any
offshore hour was downgraded to at least "watch" (to "skip" when the wind sat
above the ideal band), and `bestWindow` — which counts contiguous "go" hours —
therefore could never produce a window while the wind stayed offshore, no
matter how good the strength was. The briefing state machine additionally
counted `offshore_risk` / `cross_offshore_caution` as SAFETY_REASONS, so a
watch verdict with an offshore reason rendered as the red "Risky conditions"
hero on Today.

In practice this misfires: many real spots (e.g. the Marmara's north shore
under a NE'ly) blow offshore most of the season and are ridden anyway. An
11 kt steady offshore day showed a red "Risky conditions" headline, a red
danger card, and an empty timeline — while the explanation sentence itself
said the wind was merely "a touch below ideal; steady; fresh". The tone and
the facts disagreed, and the window's blanket offshore veto made the
timeline useless exactly at the spots where riders live.

## Options considered

1. **Keep the veto, soften only the client copy** — the headline softens but
   the window stays structurally empty at offshore spots; the core complaint
   survives.
2. **Scale the offshore penalty with strength** — tunable, but direction still
   moves verdicts, so "why is this spot yellow at perfect wind" persists and
   every tuning argument reopens it.
3. **Strength-only verdicts; direction demoted to an advisory** — chosen.

## Decision

The verdict (and everything derived from it: hourly decisions, daily
headlines, `bestWindow`, briefing ranking tiers and state) is computed from
wind STRENGTH and weather hazards only: the per-sport band, overpowering
gusts, thunderstorm/CAPE, heavy precipitation. Shore side never moves a
verdict.

- `DecisionInput` loses its direction fields; `decisionReasons` takes a
  `ReasonInput` superset that still derives the side, so `offshore_risk` /
  `cross_offshore_caution` / `cross_shore` / … continue to ride the reasons
  list — they inform, they don't score.
- The briefing's SAFETY_REASONS (the gate into the red "risky" state) shrinks
  to `gusts_overpowering` + `storm_risk` — the conditions that are dangerous
  regardless of where you launch.
- The client renders direction reasons as the amber Level-1 advisory ("the
  wind blows from the shore out to sea — keep an eye on your distance from
  land"), never the red Level-2 card; red is reserved for storm/gust danger.

## Consequences

- An offshore day with in-band wind is a "go" with an amber caveat, matching
  how locals actually treat their home spots; the timeline window reappears.
- The canonical offshore hazard is still surfaced every time (reasons are
  unchanged), just at informational severity. If real-world feedback shows
  that's too quiet for genuinely dangerous offshore days, the correct dial is
  the advisory copy/severity — not re-adding direction to the verdict.
- Per-skill bands (the documented fast-follow) stay the intended next lever
  on the strength axis.
