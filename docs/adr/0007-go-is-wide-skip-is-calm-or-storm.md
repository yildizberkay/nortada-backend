# 0007 — GO is one wide band; skip means calm or storm-force, nothing else

- **Status:** accepted
- **Date:** 2026-07-18
- **Scope:** nortada-backend (`decision.ts` thresholds; drives every verdict surface)

## Context

After ADR-0006 made wind strength the only verdict parameter, the band table
still gatekept aggressively: windsurf's "go" was 12–25 kt, 25–35 kt dropped to
watch, >35 kt was a flat "skip", and <10 kt was a flat "skip" too. Product
review (2026-07-18) rejected that posture: an intermediate windsurfer is fine
from 10 kt; 25–35 kt is a normal strong day, not a caution tier; >35 kt is
professional territory but "skip" is patronizing — a pro on the Adriatic in
25+ kt dinghy weather goes out and merely wants to be told to be careful; and
the light end should read as "you can, it's just not ideal" rather than a
warning.

## Decision

Verdicts widen; nuance moves entirely to reason codes (the client localizes):

- **GO is one wide rideable band** — the old ideal and strong ranges merged
  (windsurf 10–35 kt, kite 12–33, wing 13–30, sailing 8–25, other 8–30).
  Within GO, hours above the old ideal ceiling emit the new `wind_strong`
  reason ("solid day — size down"); the verdict stays go and those hours count
  toward `bestWindow`.
- **Above GO is a watch, not a skip**: the pro band (up to 45 kt) emits
  `wind_above_ideal`, now meaning "go, but experienced and very careful". It
  feeds the briefing's SAFETY_REASONS so a 38 kt day still headlines as
  caution for a general audience.
- **A single extreme cap, 45 kt mean, for every wind sport** → skip
  (`too_strong`, "storm-force"). Rationale: 45 kt mean ≈ Beaufort 9/10 with
  55+ gusts — storm-chase territory, and storm weather codes usually force the
  skip anyway. This is the only strength-based skip at the top.
- **The light end softens**: below the go floor down to the calm floor
  (windsurf 6–10 kt) is a watch whose copy invites rather than warns
  ("doable, good for practice"); below the calm floor is a skip with
  no-drama "no wind" copy. Windsurf's calm floor is 6 kt (below that nothing
  happens on the water); dinghy keeps 4 kt (a heavy hull under 4 kt is
  genuinely joyless).
- **Gust safety keeps the OLD ceilings** via a dedicated `overpowerMs` field
  (windsurf 35 kt, sup 15 kt, …): gusts above it still force a watch. This is
  deliberately decoupled from the widened bands — without it the inverted
  sports (SUP/kayak/surf, whose tables are unchanged) would trip the gust rule
  at trivial spreads.
- Ranking still prefers the sweet spot: `idealBandMidMs` is the midpoint of
  go-floor → strong-note boundary, NOT of the merged band, so a 17 kt spot
  outranks a 30 kt one for a windsurfer.

Mean wind remains the input (Windguru-style industry norm); a gust-blended
"effective wind" was considered and rejected for now.

## Consequences

- `wind_strong` is a NEW reason code in the briefing schema enum — the iOS
  client must regenerate SplashAPI from the new spec before this deploys, or
  briefing decodes fail (closed enum on both sides).
- "Skip" pins/verdicts now genuinely mean "there is nothing to do here" (calm)
  or "nobody should be out" (storm-force/thunderstorm) — copy can lean on that.
- If the pro band proves too permissive for a specific sport, the dial is that
  sport's `proMs`/`extremeMs`, not a return to skip-at-the-top.
