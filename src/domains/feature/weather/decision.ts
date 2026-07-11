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
 * Per-sport ideal wind bands in canonical SI m/s. These are reasoned defaults
 * (the PRD's exact §12.6 matrix wasn't on disk) and are meant to be TUNED — see
 * docs/otonom-kararlar.md. SUP/kayak invert the usual logic: flat water is best,
 * so more wind is worse (ideal band starts at 0).
 */
const THRESHOLDS: Record<Sport, WindThreshold> = {
  windsurf: { minMs: 5, idealMinMs: 7, idealMaxMs: 14, maxMs: 20 },
  wingfoil: { minMs: 5, idealMinMs: 6, idealMaxMs: 12, maxMs: 18 },
  kitesurf: { minMs: 5, idealMinMs: 6, idealMaxMs: 13, maxMs: 18 },
  sailing: { minMs: 3, idealMinMs: 4, idealMaxMs: 10, maxMs: 16 },
  sup: { minMs: 0, idealMinMs: 0, idealMaxMs: 4, maxMs: 8 },
  kayak: { minMs: 0, idealMinMs: 0, idealMaxMs: 5, maxMs: 9 },
  other: { minMs: 4, idealMinMs: 5, idealMaxMs: 12, maxMs: 18 },
};

// WMO weather codes.
const isThunderstorm = (code: number) => code >= 95;
const isHeavyPrecip = (code: number) => [65, 67, 75, 82, 86].includes(code);

const SEVERITY: Record<Decision, number> = { go: 0, watch: 1, skip: 2 };
const worse = (a: Decision, b: Decision): Decision =>
  SEVERITY[a] >= SEVERITY[b] ? a : b;

export interface DecisionInput {
  sport: Sport;
  windMs: number;
  gustMs: number;
  weatherCode: number;
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
  const { sport, windMs, gustMs, weatherCode } = input;
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
  // Offshore wind blows the rider out to sea — a real safety downgrade.
  if (sideOf(input) === "offshore") d = worse(d, "watch");
  if (isHeavyPrecip(weatherCode)) d = worse(d, "watch");

  return d;
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
      return {
        start: hourly.time[runStart],
        end: hourly.time[i - 1],
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
