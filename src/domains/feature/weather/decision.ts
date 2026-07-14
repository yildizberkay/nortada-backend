import type { Spot } from "@/db";
import { type WindSide, windSide } from "@/packages/geo";

type Sport = Spot["supportedSports"][number];

export type Decision = "go" | "watch" | "skip";
export type Confidence = "low" | "medium" | "high";

interface WindThreshold {
  minMs: number; // below → too light
  idealMinMs: number;
  idealMaxMs: number;
  maxMs: number; // above → too strong
}

/**
 * Per-sport ideal wind bands in canonical SI m/s (1 kt ≈ 0.5144 m/s). Bands are
 * research-backed from watersports sources (windup.live, mackiteboarding,
 * kiteworldwide, dinghy/Beaufort guides, SUP/kayak safety guides — see
 * docs/otonom-kararlar.md §24) at a general/INTERMEDIATE skill level. Per-skill
 * bands (a beginner's ceiling is much lower) are a documented fast-follow tied
 * to threading the user's experience in. SUP/kayak invert the usual logic —
 * flat water is best, so more wind is worse (ideal band starts at 0).
 *
 *   sport     too-light(skip) │  IDEAL (go)  │ too-strong(skip)   [knots]
 *   windsurf     <10           │   12 – 25    │   >35
 *   wingfoil     <11           │   13 – 22    │   >30
 *   kitesurf     <10           │   12 – 25    │   >33
 *   sailing      <4            │    8 – 16    │   >25   (dinghy reefs ~20)
 *   sup           —            │    0 – 5     │   >15
 *   kayak         —            │    0 – 6     │   >16
 *   surfing       —            │    0 – 8     │   >20  (wind ruins the wave face)
 *   other        <4            │    8 – 20    │   >30
 */
const THRESHOLDS: Record<Sport, WindThreshold> = {
  windsurf: { minMs: 5.1, idealMinMs: 6.2, idealMaxMs: 12.9, maxMs: 18.0 },
  wingfoil: { minMs: 5.7, idealMinMs: 6.7, idealMaxMs: 11.3, maxMs: 15.4 },
  kitesurf: { minMs: 5.1, idealMinMs: 6.2, idealMaxMs: 12.9, maxMs: 17.0 },
  sailing: { minMs: 2.1, idealMinMs: 4.1, idealMaxMs: 8.2, maxMs: 12.9 },
  sup: { minMs: 0, idealMinMs: 0, idealMaxMs: 2.6, maxMs: 7.7 },
  kayak: { minMs: 0, idealMinMs: 0, idealMaxMs: 3.1, maxMs: 8.2 },
  // Wave-riding inverts like SUP: glassy/light is ideal, strong wind chops the
  // face. (Swell quality itself is a marine-data fast-follow.)
  surfing: { minMs: 0, idealMinMs: 0, idealMaxMs: 4.1, maxMs: 10.3 },
  other: { minMs: 2.1, idealMinMs: 4.1, idealMaxMs: 10.3, maxMs: 15.4 },
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

export interface DecisionInput {
  sport: Sport;
  windMs: number;
  gustMs: number;
  weatherCode: number;
  capeJkg?: number;
  // Meteorological "from" direction; combined with shoreBearing → side.
  windDirectionDeg?: number;
  shoreBearingDeg?: number | null;
}

const sideOf = (input: DecisionInput): WindSide | undefined =>
  input.shoreBearingDeg != null && input.windDirectionDeg != null
    ? windSide(input.shoreBearingDeg, input.windDirectionDeg)
    : undefined;

/** Go/Watch/Skip for a single hour. Modifiers can only downgrade. */
export function computeDecision(input: DecisionInput): Decision {
  const { sport, windMs, gustMs, weatherCode, capeJkg } = input;
  const t = THRESHOLDS[sport];

  if (isThunderstorm(weatherCode)) return "skip";

  let d: Decision;
  if (windMs < t.minMs) d = "skip";
  else if (windMs < t.idealMinMs) d = "watch";
  else if (windMs <= t.idealMaxMs) d = "go";
  else if (windMs <= t.maxMs) d = "watch";
  else d = "skip";

  // Gusts overpowering the sport's ceiling → caution even if the mean is fine.
  if (gustMs > t.maxMs) d = worse(d, "watch");

  // Offshore wind blows the rider out to sea — the canonical life-threatening
  // case. Scale with strength: strong offshore → skip; else watch. Cross-offshore
  // (still a strong seaward component) gets a watch too.
  const side = sideOf(input);
  if (side === "offshore") {
    d = worse(d, windMs > t.idealMaxMs ? "skip" : "watch");
  } else if (side === "cross-offshore") {
    d = worse(d, "watch");
  }

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
  | "wind_above_ideal"
  | "too_light"
  | "too_strong"
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

/** Midpoint of the sport's ideal band — the briefing's ranking tiebreak
 * ("closest to perfect wind") without leaking the threshold table. */
export function idealBandMidMs(sport: Sport): number {
  const t = THRESHOLDS[sport];
  return (t.idealMinMs + t.idealMaxMs) / 2;
}

/**
 * The explanation counterpart of `computeDecision`: the same inputs, the same
 * `THRESHOLDS`, but a priority-ordered reason list (band → shore side → gust
 * character → storm/precip) instead of a verdict. Kept separate so the hot
 * verdict paths (hourly loops, dailies) never pay for reason allocation.
 */
export function decisionReasons(input: DecisionInput): DecisionReason[] {
  const { sport, windMs, gustMs, weatherCode, capeJkg } = input;
  const t = THRESHOLDS[sport];
  const reasons: DecisionReason[] = [];

  if (windMs < t.minMs) reasons.push("too_light");
  else if (windMs < t.idealMinMs) reasons.push("wind_below_ideal");
  else if (windMs <= t.idealMaxMs) reasons.push("wind_in_ideal_band");
  else if (windMs <= t.maxMs) reasons.push("wind_above_ideal");
  else reasons.push("too_strong");

  const side = sideOf(input);
  if (side === "offshore") reasons.push("offshore_risk");
  else if (side === "cross-offshore") reasons.push("cross_offshore_caution");
  else if (side === "cross-shore") reasons.push("cross_shore");
  else if (side === "cross-onshore") reasons.push("cross_onshore");
  else if (side === "onshore") reasons.push("onshore");

  const spread = gustMs - windMs;
  if (gustMs > t.maxMs) reasons.push("gusts_overpowering");
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
 */
export function bestWindow(
  hourly: HourlySeries,
  sport: Sport,
  shoreBearingDeg: number | null,
  horizonHours = 48,
): BestWindow | null {
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
      windDirectionDeg: hourly.windDirectionDeg[i],
      shoreBearingDeg,
    });

    if (decision === "go") {
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
