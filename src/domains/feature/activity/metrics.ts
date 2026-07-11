import { haversineKm } from "@/packages/geo";

// Canonical metric engine (D-001): raw GPS track → summary + best efforts +
// route polyline. PURE + unit-tested, independent of DB/HTTP. All SI.
//
// The exact metric set is aligned with the app's speedsurfing metrics
// (AnalyticsModels.swift); alpha / by-side / planing efforts are P1.

export const ALGORITHM_VERSION = 1;

// A raw sample. `speed` is the device's Doppler groundSpeed (more accurate than
// position-derived); `hAccuracy` is horizontal accuracy in metres.
export interface Sample {
  t: number; // seconds (epoch or session-relative — only deltas are used)
  lat: number;
  lon: number;
  speed?: number; // m/s
  hAccuracy?: number; // m
}

// Reject samples worse than this horizontal accuracy (metres).
const MAX_HACCURACY_M = 25;
// Reject implausible speeds (~78 kt) as GPS spikes.
const MAX_SPEED_MS = 40;
// Below this speed a sample counts as "not moving".
const MOVING_THRESHOLD_MS = 1;
// A time gap larger than this between samples is a tracking gap.
const GAP_THRESHOLD_SEC = 5;
// Guardrails against producing efforts for a too-short session.
const MIN_SESSION_SEC = 60;
const MIN_VALID_SAMPLES = 20;

const TIME_EFFORTS: Array<[string, number]> = [
  ["time_2s", 2],
  ["time_5s", 5],
  ["time_10s", 10],
  ["time_20s", 20],
  ["time_30s", 30],
  ["time_1m", 60],
  ["time_5m", 300],
];

const DISTANCE_EFFORTS: Array<[string, number]> = [
  ["dist_100m", 100],
  ["dist_250m", 250],
  ["dist_500m", 500],
  ["dist_1km", 1000],
  ["dist_nm", 1852],
];

export interface SummaryValues {
  totalDistanceM: number;
  maxSpeedMs: number;
  avgSpeedMs: number;
  avgMovingSpeedMs: number;
  durationSec: number;
  movingDurationSec: number;
  maxDistanceFromStartM: number;
  validSampleCount: number;
  gapCount: number;
}

export interface EffortValue {
  type: string;
  resultMs: number;
  durationSec?: number;
  distanceM?: number;
  startOffsetSec?: number;
}

export interface MetricsResult {
  summary: SummaryValues;
  efforts: EffortValue[];
  polyline: string;
}

const metresBetween = (a: Sample, b: Sample): number =>
  haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;

/** Drop invalid samples, keep chronological order, dedupe identical timestamps. */
function cleanSamples(samples: Sample[]): Sample[] {
  const valid = samples
    .filter(
      (s) =>
        Number.isFinite(s.t) &&
        Number.isFinite(s.lat) &&
        Number.isFinite(s.lon) &&
        Math.abs(s.lat) <= 90 &&
        Math.abs(s.lon) <= 180 &&
        (s.hAccuracy == null || s.hAccuracy <= MAX_HACCURACY_M),
    )
    .sort((a, b) => a.t - b.t);

  const out: Sample[] = [];
  for (const s of valid) {
    if (out.length === 0 || s.t > out[out.length - 1].t) out.push(s);
  }
  return out;
}

/** Best average speed (m/s) over any window of at least `windowSec` seconds. */
function bestTimeEffort(
  t: number[],
  cumDist: number[],
  windowSec: number,
): { resultMs: number; startOffsetSec: number } | null {
  let best = 0;
  let bestStart = -1;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    if (j < i) j = i;
    while (j < t.length && t[j] - t[i] < windowSec) j++;
    if (j >= t.length) break;
    const dt = t[j] - t[i];
    const speed = (cumDist[j] - cumDist[i]) / dt;
    if (speed > best) {
      best = speed;
      bestStart = t[i] - t[0];
    }
  }
  return bestStart < 0 ? null : { resultMs: best, startOffsetSec: bestStart };
}

/** Fastest average speed (m/s) to cover at least `distanceM` metres. */
function bestDistanceEffort(
  t: number[],
  cumDist: number[],
  distanceM: number,
): { resultMs: number; startOffsetSec: number } | null {
  let best = 0;
  let bestStart = -1;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    if (j < i) j = i;
    while (j < t.length && cumDist[j] - cumDist[i] < distanceM) j++;
    if (j >= t.length) break;
    const dt = t[j] - t[i];
    if (dt <= 0) continue;
    const speed = (cumDist[j] - cumDist[i]) / dt;
    if (speed > best) {
      best = speed;
      bestStart = t[i] - t[0];
    }
  }
  return bestStart < 0 ? null : { resultMs: best, startOffsetSec: bestStart };
}

/** Average of the 5 best NON-overlapping 10-second runs (the 5×10 rule). */
function best5x10(t: number[], cumDist: number[]): number | null {
  const windows: Array<{ speed: number; start: number; end: number }> = [];
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    if (j < i) j = i;
    while (j < t.length && t[j] - t[i] < 10) j++;
    if (j >= t.length) break;
    const dt = t[j] - t[i];
    windows.push({
      speed: (cumDist[j] - cumDist[i]) / dt,
      start: t[i],
      end: t[j],
    });
  }
  windows.sort((a, b) => b.speed - a.speed);

  const picked: Array<{ start: number; end: number }> = [];
  const chosen: number[] = [];
  for (const w of windows) {
    if (chosen.length === 5) break;
    const overlaps = picked.some((p) => w.start < p.end && w.end > p.start);
    if (!overlaps) {
      picked.push({ start: w.start, end: w.end });
      chosen.push(w.speed);
    }
  }
  if (chosen.length < 5) return null;
  return chosen.reduce((a, b) => a + b, 0) / 5;
}

// Google encoded-polyline algorithm.
function encodePolyline(points: Array<[number, number]>): string {
  let last = [0, 0];
  let result = "";
  const encode = (v: number) => {
    let value = v < 0 ? ~(v << 1) : v << 1;
    let out = "";
    while (value >= 0x20) {
      out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    out += String.fromCharCode(value + 63);
    return out;
  };
  for (const [lat, lon] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lonE5 = Math.round(lon * 1e5);
    result += encode(latE5 - last[0]) + encode(lonE5 - last[1]);
    last = [latE5, lonE5];
  }
  return result;
}

export function computeMetrics(rawSamples: Sample[]): MetricsResult {
  const samples = cleanSamples(rawSamples);

  const empty: MetricsResult = {
    summary: {
      totalDistanceM: 0,
      maxSpeedMs: 0,
      avgSpeedMs: 0,
      avgMovingSpeedMs: 0,
      durationSec: 0,
      movingDurationSec: 0,
      maxDistanceFromStartM: 0,
      validSampleCount: samples.length,
      gapCount: 0,
    },
    efforts: [],
    polyline: "",
  };
  if (samples.length < 2) return empty;

  const start = samples[0];
  const t: number[] = [samples[0].t];
  const cumDist: number[] = [0];
  let totalDistance = 0;
  let movingTime = 0;
  let gapCount = 0;
  let maxSpeed = 0;
  let maxFromStart = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const dt = cur.t - prev.t;
    let segDist = metresBetween(prev, cur);

    // Spike rejection: an implausible jump-derived speed is discarded.
    const derived = dt > 0 ? segDist / dt : Number.POSITIVE_INFINITY;
    if (derived > MAX_SPEED_MS) segDist = 0;

    // Prefer the device's Doppler speed; fall back to derived.
    let speed =
      cur.speed != null && cur.speed >= 0 && cur.speed <= MAX_SPEED_MS
        ? cur.speed
        : dt > 0
          ? segDist / dt
          : 0;
    if (speed > MAX_SPEED_MS) speed = 0;

    totalDistance += segDist;
    if (dt > GAP_THRESHOLD_SEC) gapCount++;
    if (speed > MOVING_THRESHOLD_MS) movingTime += dt;
    maxSpeed = Math.max(maxSpeed, speed);
    maxFromStart = Math.max(maxFromStart, metresBetween(start, cur));

    t.push(cur.t);
    cumDist.push(totalDistance);
  }

  const durationSec = samples[samples.length - 1].t - samples[0].t;
  const avgSpeedMs = durationSec > 0 ? totalDistance / durationSec : 0;
  const avgMovingSpeedMs = movingTime > 0 ? totalDistance / movingTime : 0;

  const summary: SummaryValues = {
    totalDistanceM: totalDistance,
    maxSpeedMs: maxSpeed,
    avgSpeedMs,
    avgMovingSpeedMs,
    durationSec,
    movingDurationSec: movingTime,
    maxDistanceFromStartM: maxFromStart,
    validSampleCount: samples.length,
    gapCount,
  };

  const polyline = encodePolyline(samples.map((s) => [s.lat, s.lon]));

  // Too-short sessions produce a summary + route but NO efforts (a 100 m effort
  // at 1 Hz is on the edge of meaningful — research/gps-tracking.md).
  if (durationSec < MIN_SESSION_SEC || samples.length < MIN_VALID_SAMPLES) {
    return { summary, efforts: [], polyline };
  }

  const efforts: EffortValue[] = [];
  for (const [type, windowSec] of TIME_EFFORTS) {
    if (durationSec < windowSec) continue;
    const e = bestTimeEffort(t, cumDist, windowSec);
    if (e) {
      efforts.push({
        type,
        resultMs: e.resultMs,
        durationSec: windowSec,
        startOffsetSec: e.startOffsetSec,
      });
    }
  }
  for (const [type, distanceM] of DISTANCE_EFFORTS) {
    if (totalDistance < distanceM) continue;
    const e = bestDistanceEffort(t, cumDist, distanceM);
    if (e) {
      efforts.push({
        type,
        resultMs: e.resultMs,
        distanceM,
        startOffsetSec: e.startOffsetSec,
      });
    }
  }
  const b5x10 = best5x10(t, cumDist);
  if (b5x10 != null) efforts.push({ type: "best_5x10", resultMs: b5x10 });

  return { summary, efforts, polyline };
}
