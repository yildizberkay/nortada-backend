import { computeMetrics, type Sample } from "./metrics";

const M_PER_DEG_LAT = 111_320;

// A straight northward track at a constant speed (m/s), 1 Hz, from (38, 26).
const straightTrack = (
  seconds: number,
  speedMs: number,
  withDoppler = true,
): Sample[] =>
  Array.from({ length: seconds }, (_, i) => ({
    t: i,
    lat: 38 + (i * speedMs) / M_PER_DEG_LAT,
    lon: 26,
    speed: withDoppler ? speedMs : undefined,
    hAccuracy: 5,
  }));

describe("computeMetrics", () => {
  it("computes distance, speeds and duration for a constant-speed track", () => {
    const result = computeMetrics(straightTrack(120, 10));

    expect(result.summary.durationSec).toBe(119);
    expect(result.summary.validSampleCount).toBe(120);
    expect(result.summary.totalDistanceM).toBeGreaterThan(1170);
    expect(result.summary.totalDistanceM).toBeLessThan(1200);
    expect(result.summary.avgSpeedMs).toBeCloseTo(10, 0);
    expect(result.summary.maxSpeedMs).toBeCloseTo(10, 0);
    expect(result.polyline.length).toBeGreaterThan(0);
  });

  it("computes time + distance + 5×10 efforts", () => {
    const result = computeMetrics(straightTrack(120, 10));
    const byType = Object.fromEntries(
      result.efforts.map((e) => [e.type, e.resultMs]),
    );

    expect(byType.time_10s).toBeCloseTo(10, 0);
    expect(byType.dist_500m).toBeCloseTo(10, 0);
    expect(byType.best_5x10).toBeCloseTo(10, 0);
    // 5-minute effort can't exist in a ~2-minute session.
    expect(byType.time_5m).toBeUndefined();
    // nautical mile (1852 m) not covered in ~1190 m.
    expect(byType.dist_nm).toBeUndefined();
  });

  it("produces NO efforts for a too-short session (but still a summary)", () => {
    const result = computeMetrics(straightTrack(10, 10));
    expect(result.efforts).toEqual([]);
    expect(result.summary.totalDistanceM).toBeGreaterThan(0);
  });

  it("rejects a GPS spike so distance isn't inflated", () => {
    const track = straightTrack(120, 10);
    // One sample teleports 5 km away for a single tick.
    track[60] = { ...track[60], lat: 38.5, speed: undefined };
    const result = computeMetrics(track);
    // Without spike rejection this would be ~11 km; with it, ~1.2 km.
    expect(result.summary.totalDistanceM).toBeLessThan(2000);
  });

  it("drops low-accuracy samples", () => {
    const track = straightTrack(120, 10);
    track[30] = { ...track[30], hAccuracy: 500 };
    const result = computeMetrics(track);
    expect(result.summary.validSampleCount).toBe(119);
  });

  it("falls back to position-derived speed when Doppler is absent", () => {
    const result = computeMetrics(straightTrack(120, 8, false));
    expect(result.summary.avgSpeedMs).toBeCloseTo(8, 0);
    expect(result.summary.maxSpeedMs).toBeGreaterThan(6);
  });

  it("handles an empty/one-sample track gracefully", () => {
    expect(computeMetrics([]).summary.totalDistanceM).toBe(0);
    expect(computeMetrics([{ t: 0, lat: 38, lon: 26 }]).efforts).toEqual([]);
  });

  it("does not inflate avgMovingSpeed with idle drift", () => {
    // 60 s planing at 10 m/s, then a LONG (300 s) not-moving stretch that still
    // creeps at 0.9 m/s (< the 1 m/s moving threshold). That idle creep adds
    // ~270 m of distance but zero moving-time, so the buggy formula
    // (totalDistance / movingTime) reads ~14.6 m/s while the correct one
    // (movingDistance / movingTime) stays ~10. The bounds below only pass for
    // the correct formula.
    const moving = straightTrack(60, 10);
    const lastMoving = moving[moving.length - 1];
    const idle: Sample[] = Array.from({ length: 300 }, (_, i) => ({
      t: 60 + i,
      lat: lastMoving.lat + (i * 0.9) / M_PER_DEG_LAT, // 0.9 m/s creep (< 1 m/s)
      lon: 26,
      speed: 0.9,
      hAccuracy: 5,
    }));
    const result = computeMetrics([...moving, ...idle]);

    // Whole-session average is low (mostly idle); moving average must stay near
    // the true 10 m/s planing speed and NOT be inflated by the idle distance.
    expect(result.summary.avgSpeedMs).toBeLessThan(7);
    expect(result.summary.avgMovingSpeedMs).toBeGreaterThan(9);
    expect(result.summary.avgMovingSpeedMs).toBeLessThanOrEqual(10.2);
  });

  it("does not let a lone bad Doppler reading set maxSpeed", () => {
    const track = straightTrack(120, 10);
    // A single sample reports 30 m/s (58 kt) on Doppler while the track shows it
    // covered only a normal ~10 m of ground — an uncorroborated spike.
    track[60] = { ...track[60], speed: 30, sAccuracy: 5 };
    const result = computeMetrics(track);
    // maxSpeed stays at the real ~10 m/s, not the 30 m/s spike.
    expect(result.summary.maxSpeedMs).toBeLessThan(15);
  });
});
