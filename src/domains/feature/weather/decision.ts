import type { Spot } from "@/db";
import { type WindSide, windSide } from "@/packages/geo";

type Sport = Spot["supportedSports"][number];

export type Decision = "go" | "watch" | "skip";
export type Confidence = "low" | "medium" | "high";

interface WindThreshold {
  minMs: number; // below → calm skip ("no wind", soft copy — not a warning)
  idealMinMs: number; // go floor; minMs..here = doable-but-light watch
  strongMs: number; // within go, above → "wind_strong" explanation note
  proMs: number; // above → experts-only watch ("go, but very carefully")
  extremeMs: number; // above → skip (storm-force)
  overpowerMs: number; // gusts above → watch; the sport's holdable gust limit
  daylightBound: boolean; // window only counts daylight hours (night riding
  // isn't a thing for these sports; sailing is exempt — night sailing is a
  // legitimate discipline/training)
}

/**
 * Per-sport wind bands in canonical SI m/s (1 kt ≈ 0.5144 m/s). Reworked per
 * ADR-0007: GO is one wide rideable band (the old ideal + strong-but-fine
 * ranges merged); verdicts stop gatekeeping and the nuance rides the reason
 * codes (`wind_strong`, `wind_above_ideal`). Skip only means "no wind" (below
 * min, calm copy) or "storm-force" (above extreme, 45 kt for every wind
 * sport). SUP/kayak/surfing keep their inverted flat-water logic unchanged
 * (strongMs = proMs → no strong note; their old bands are preserved).
 * Per-skill bands stay the documented fast-follow.
 *
 *   sport     calm(skip) │ light(watch) │    GO     │ strong-note │ pro(watch) │ extreme(skip)   [knots]
 *   windsurf     <6      │    6 – 10    │  10 – 35  │    25+      │  35 – 45   │   >45
 *   wingfoil     <11     │   11 – 13    │  13 – 30  │    22+      │  30 – 45   │   >45
 *   kitesurf     <10     │   10 – 12    │  12 – 33  │    25+      │  33 – 45   │   >45
 *   sailing      <4      │    4 – 8     │   8 – 25  │    16+      │  25 – 45   │   >45
 *   sup           —      │      —       │   0 – 5   │     —       │   5 – 15   │   >15
 *   kayak         —      │      —       │   0 – 6   │     —       │   6 – 16   │   >16
 *   surfing       —      │      —       │   0 – 8   │     —       │   8 – 20   │   >20
 *   other        <4      │    4 – 8     │   8 – 30  │    20+      │  30 – 45   │   >45
 */
const EXTREME_MS = 23.1; // 45 kt — storm-force for every wind sport
// prettier-ignore
const THRESHOLDS: Record<Sport, WindThreshold> = {
  windsurf: {
    minMs: 3.1,
    idealMinMs: 5.1,
    strongMs: 12.9,
    proMs: 18.0,
    extremeMs: EXTREME_MS,
    overpowerMs: 18.0,
    daylightBound: true,
  },
  wingfoil: {
    minMs: 5.7,
    idealMinMs: 6.7,
    strongMs: 11.3,
    proMs: 15.4,
    extremeMs: EXTREME_MS,
    overpowerMs: 15.4,
    daylightBound: true,
  },
  kitesurf: {
    minMs: 5.1,
    idealMinMs: 6.2,
    strongMs: 12.9,
    proMs: 17.0,
    extremeMs: EXTREME_MS,
    overpowerMs: 17.0,
    daylightBound: true,
  },
  sailing: {
    minMs: 2.1,
    idealMinMs: 4.1,
    strongMs: 8.2,
    proMs: 12.9,
    extremeMs: EXTREME_MS,
    overpowerMs: 12.9,
    daylightBound: false,
  },
  // Inverted flat-water sports: proMs = strongMs (no strong note; the pro
  // band IS their old watch band) and the gust limit is their old ceiling.
  sup: {
    minMs: 0,
    idealMinMs: 0,
    strongMs: 2.6,
    proMs: 2.6,
    extremeMs: 7.7,
    overpowerMs: 7.7,
    daylightBound: true,
  },
  kayak: {
    minMs: 0,
    idealMinMs: 0,
    strongMs: 3.1,
    proMs: 3.1,
    extremeMs: 8.2,
    overpowerMs: 8.2,
    daylightBound: true,
  },
  // Wave-riding inverts like SUP: glassy/light is ideal, strong wind chops the
  // face. (Swell quality itself is a marine-data fast-follow.)
  surfing: {
    minMs: 0,
    idealMinMs: 0,
    strongMs: 4.1,
    proMs: 4.1,
    extremeMs: 10.3,
    overpowerMs: 10.3,
    daylightBound: true,
  },
  other: {
    minMs: 2.1,
    idealMinMs: 4.1,
    strongMs: 10.3,
    proMs: 15.4,
    extremeMs: EXTREME_MS,
    overpowerMs: 15.4,
    daylightBound: true,
  },
};

// WMO weather codes.
const isThunderstorm = (code: number) => code >= 95;
const isHeavyPrecip = (code: number) => [65, 67, 75, 82, 86].includes(code);

// Convective Available Potential Energy — the PRE-storm lead-time signal
// (weather_code only reaches 95 once lightning is already active). J/kg.
const CAPE_WATCH = 1000; // building instability
const CAPE_SKIP = 2500; // high thunderstorm risk

const SEVERITY: Record<Decision, number> = { go: 0, watch: 1, skip: 2 };
const worse = (a: Decision, b: Decision): Decision =>
  SEVERITY[a] >= SEVERITY[b] ? a : b;

/** What the verdict sees: wind strength and weather only. Shore side is
 * deliberately NOT here (ADR-0006) — direction never moves a verdict; it is
 * surfaced as an advisory reason via `ReasonInput` instead. */
export interface DecisionInput {
  sport: Sport;
  windMs: number;
  gustMs: number;
  weatherCode: number;
  capeJkg?: number;
}

/** Reasons additionally describe the shore side (advisory-only). */
export interface ReasonInput extends DecisionInput {
  // Meteorological "from" direction; combined with shoreBearing → side.
  windDirectionDeg?: number;
  shoreBearingDeg?: number | null;
}

const sideOf = (input: ReasonInput): WindSide | undefined =>
  input.shoreBearingDeg != null && input.windDirectionDeg != null
    ? windSide(input.shoreBearingDeg, input.windDirectionDeg)
    : undefined;

/** Go/Watch/Skip for a single hour, from wind STRENGTH and weather alone.
 * Modifiers can only downgrade. */
export function computeDecision(input: DecisionInput): Decision {
  const { sport, windMs, gustMs, weatherCode, capeJkg } = input;
  const t = THRESHOLDS[sport];

  if (isThunderstorm(weatherCode)) return "skip";

  let d: Decision;
  if (windMs < t.minMs)
    d = "skip"; // calm — "no wind", not a warning
  else if (windMs < t.idealMinMs)
    d = "watch"; // light — doable, not ideal
  else if (windMs <= t.proMs) d = "go";
  else if (windMs <= t.extremeMs)
    d = "watch"; // experts only, carefully
  else d = "skip"; // storm-force

  // Gusts overpowering what the sport can hold → caution even if the mean
  // sits comfortably in the go band.
  if (gustMs > t.overpowerMs) d = worse(d, "watch");

  // Pre-storm instability (before weather_code catches up).
  if (capeJkg != null) {
    if (capeJkg > CAPE_SKIP) d = worse(d, "skip");
    else if (capeJkg > CAPE_WATCH) d = worse(d, "watch");
  }

  if (isHeavyPrecip(weatherCode)) d = worse(d, "watch");

  return d;
}

/** Structural "why" codes for a verdict — the client localizes; the server
 * never ships prose. Emitted by `decisionReasons` from the SAME thresholds as
 * `computeDecision`, so verdict and explanation cannot drift (RFC-0010). */
export type DecisionReason =
  | "wind_in_ideal_band"
  | "wind_below_ideal"
  | "wind_strong" // upper GO band — solid day, size down
  | "wind_above_ideal" // pro watch band — go, but experienced + careful
  | "too_light" // calm — soft "no wind" copy, never a warning
  | "too_strong" // storm-force extreme
  | "onshore"
  | "cross_onshore"
  | "cross_shore"
  | "cross_offshore_caution"
  | "offshore_risk"
  | "steady_wind"
  | "gusty"
  | "gusts_overpowering"
  | "storm_risk"
  | "heavy_precipitation";

const GUSTY_SPREAD_MS = 4; // noticeable gust spread; > ceiling = overpowering

/** Midpoint of the sport's sweet spot (go floor → strong-note boundary) —
 * the briefing's ranking tiebreak ("closest to perfect wind") without leaking
 * the threshold table. Deliberately NOT the merged go band's midpoint: ranking
 * should still prefer 17 kt over 30 kt for a windsurfer. */
export function idealBandMidMs(sport: Sport): number {
  const t = THRESHOLDS[sport];
  return (t.idealMinMs + t.strongMs) / 2;
}

/**
 * The explanation counterpart of `computeDecision`: the same thresholds, but a
 * priority-ordered reason list (band → shore side → gust character →
 * storm/precip) instead of a verdict. Shore side appears HERE only — it
 * informs (and drives the client's direction advisory) but never scores
 * (ADR-0006). Kept separate so the hot verdict paths (hourly loops, dailies)
 * never pay for reason allocation.
 */
export function decisionReasons(input: ReasonInput): DecisionReason[] {
  const { sport, windMs, gustMs, weatherCode, capeJkg } = input;
  const t = THRESHOLDS[sport];
  const reasons: DecisionReason[] = [];

  if (windMs < t.minMs) reasons.push("too_light");
  else if (windMs < t.idealMinMs) reasons.push("wind_below_ideal");
  else if (windMs <= t.strongMs) reasons.push("wind_in_ideal_band");
  else if (windMs <= t.proMs) reasons.push("wind_strong");
  else if (windMs <= t.extremeMs) reasons.push("wind_above_ideal");
  else reasons.push("too_strong");

  const side = sideOf(input);
  if (side === "offshore") reasons.push("offshore_risk");
  else if (side === "cross-offshore") reasons.push("cross_offshore_caution");
  else if (side === "cross-shore") reasons.push("cross_shore");
  else if (side === "cross-onshore") reasons.push("cross_onshore");
  else if (side === "onshore") reasons.push("onshore");

  const spread = gustMs - windMs;
  if (gustMs > t.overpowerMs) reasons.push("gusts_overpowering");
  else if (spread > GUSTY_SPREAD_MS) reasons.push("gusty");
  else reasons.push("steady_wind");

  if (
    isThunderstorm(weatherCode) ||
    (capeJkg != null && capeJkg > CAPE_WATCH)
  ) {
    reasons.push("storm_risk");
  }
  if (isHeavyPrecip(weatherCode)) reasons.push("heavy_precipitation");

  return reasons;
}

export interface ConfidenceInput {
  stale: boolean;
  gustSpreadMs: number;
  precipitationProbability: number;
}

/** Forecast confidence: staleness dominates, then gustiness + precip odds. */
export function computeConfidence(input: ConfidenceInput): Confidence {
  if (input.stale) return "low";
  if (input.gustSpreadMs > 8 || input.precipitationProbability > 60) {
    return "medium";
  }
  return "high";
}

export interface HourlySeries {
  time: string[];
  windSpeedMs: number[];
  windGustsMs: number[];
  windDirectionDeg: number[];
  weatherCode: number[];
  capeJkg: number[];
}

export interface BestWindow {
  start: string;
  end: string;
  peakWindMs: number;
}

/**
 * The soonest contiguous run of "go" hours within the next `horizonHours`.
 * Returns null when nothing is suitable. "Soonest" beats "longest" — a rider
 * wants to know when they can go out today, not the theoretically best slot.
 * Strength-only like the verdict it derives from (ADR-0006): an offshore day
 * with ideal wind still gets its window; the direction advisory rides along
 * separately.
 */
export function bestWindow(
  hourly: HourlySeries,
  sport: Sport,
  horizonHours = 48,
  // Per-hour daylight mask (same indexing as `hourly`). For daylight-bound
  // sports a night hour never joins a window — nobody plans a session they
  // can't see. A missing mask fails OPEN (hour counts): daylight is a window
  // filter, never a reason to hide wind.
  isDay?: boolean[],
): BestWindow | null {
  const t = THRESHOLDS[sport];
  const n = Math.min(hourly.time.length, horizonHours);
  let runStart = -1;
  let peak = 0;

  for (let i = 0; i < n; i++) {
    const decision = computeDecision({
      sport,
      windMs: hourly.windSpeedMs[i] ?? 0,
      gustMs: hourly.windGustsMs[i] ?? 0,
      weatherCode: hourly.weatherCode[i] ?? 0,
      capeJkg: hourly.capeJkg[i],
    });
    const usable =
      decision === "go" && (!t.daylightBound || isDay?.[i] !== false);

    if (usable) {
      if (runStart === -1) {
        runStart = i;
        peak = 0;
      }
      peak = Math.max(peak, hourly.windSpeedMs[i] ?? 0);
    } else if (runStart !== -1) {
      // `end` is the exclusive hour-boundary after the last go-hour, so a
      // single go-hour reads as a 1h span (13:00–14:00), not 13:00–13:00.
      return {
        start: hourly.time[runStart],
        end: hourly.time[i],
        peakWindMs: peak,
      };
    }
  }

  if (runStart !== -1) {
    return {
      start: hourly.time[runStart],
      end: hourly.time[n - 1],
      peakWindMs: peak,
    };
  }
  return null;
}
