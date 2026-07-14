import {
  bestWindow,
  computeConfidence,
  computeDecision,
  decisionReasons,
  type HourlySeries,
} from "./decision";

describe("computeDecision", () => {
  it("windsurf: go in the ideal band", () => {
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 10,
        gustMs: 12,
        weatherCode: 0,
      }),
    ).toBe("go");
  });

  it("windsurf: watch when marginal-light", () => {
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 6,
        gustMs: 8,
        weatherCode: 0,
      }),
    ).toBe("watch");
  });

  it("windsurf: skip when too light or too strong", () => {
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 3,
        gustMs: 5,
        weatherCode: 0,
      }),
    ).toBe("skip");
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 25,
        gustMs: 30,
        weatherCode: 0,
      }),
    ).toBe("skip");
  });

  it("SUP inverts: flat/light is go, windy is skip", () => {
    expect(
      computeDecision({ sport: "sup", windMs: 2, gustMs: 3, weatherCode: 0 }),
    ).toBe("go");
    expect(
      computeDecision({ sport: "sup", windMs: 12, gustMs: 15, weatherCode: 0 }),
    ).toBe("skip");
  });

  it("thunderstorm forces skip regardless of wind", () => {
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 10,
        gustMs: 12,
        weatherCode: 95,
      }),
    ).toBe("skip");
  });

  it("offshore wind downgrades go → watch (safety)", () => {
    // West-facing shore (bearing 270); wind FROM the east (90) is offshore.
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 10,
        gustMs: 12,
        weatherCode: 0,
        windDirectionDeg: 90,
        shoreBearingDeg: 270,
      }),
    ).toBe("watch");
  });

  it("overpowering gusts downgrade go → watch", () => {
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 12,
        gustMs: 24,
        weatherCode: 0,
      }),
    ).toBe("watch");
  });

  it("strong offshore wind downgrades all the way to skip", () => {
    // 16 m/s > windsurf idealMax (14) + offshore → skip (can't get back).
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 16,
        gustMs: 18,
        weatherCode: 0,
        windDirectionDeg: 90,
        shoreBearingDeg: 270,
      }),
    ).toBe("skip");
  });

  it("pre-storm CAPE downgrades before the storm code appears", () => {
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 10,
        gustMs: 12,
        weatherCode: 0,
        capeJkg: 1500,
      }),
    ).toBe("watch");
    expect(
      computeDecision({
        sport: "windsurf",
        windMs: 10,
        gustMs: 12,
        weatherCode: 0,
        capeJkg: 3000,
      }),
    ).toBe("skip");
  });
});

describe("computeConfidence", () => {
  it("stale data is always low confidence", () => {
    expect(
      computeConfidence({
        stale: true,
        gustSpreadMs: 1,
        precipitationProbability: 0,
      }),
    ).toBe("low");
  });

  it("gusty / rainy is medium", () => {
    expect(
      computeConfidence({
        stale: false,
        gustSpreadMs: 10,
        precipitationProbability: 0,
      }),
    ).toBe("medium");
  });

  it("fresh + steady is high", () => {
    expect(
      computeConfidence({
        stale: false,
        gustSpreadMs: 2,
        precipitationProbability: 10,
      }),
    ).toBe("high");
  });
});

describe("bestWindow", () => {
  const series = (winds: number[]): HourlySeries => ({
    time: winds.map((_, i) => `2026-07-11T${String(i).padStart(2, "0")}:00`),
    windSpeedMs: winds,
    windGustsMs: winds.map((w) => w + 1),
    windDirectionDeg: winds.map(() => 270),
    weatherCode: winds.map(() => 0),
    capeJkg: winds.map(() => 0),
  });

  it("finds the soonest contiguous go-run (exclusive end boundary)", () => {
    // hours: light, GO, GO, light... → covers 01:00 and 02:00, ends at 03:00.
    const w = bestWindow(series([3, 10, 11, 3, 3]), "windsurf", null);
    expect(w).not.toBeNull();
    expect(w?.start).toBe("2026-07-11T01:00");
    expect(w?.end).toBe("2026-07-11T03:00");
    expect(w?.peakWindMs).toBe(11);
  });

  it("returns null when nothing is suitable", () => {
    expect(bestWindow(series([2, 2, 2]), "windsurf", null)).toBeNull();
  });
});

describe("decisionReasons", () => {
  it("mirrors computeDecision's band verdict: ideal band + steady + cross-shore", () => {
    const input = {
      sport: "windsurf" as const,
      windMs: 10,
      gustMs: 12,
      weatherCode: 0,
      windDirectionDeg: 0,
      shoreBearingDeg: 90,
    };
    expect(computeDecision(input)).toBe("go");
    expect(decisionReasons(input)).toEqual([
      "wind_in_ideal_band",
      "cross_shore",
      "steady_wind",
    ]);
  });

  it("flags the offshore life-safety case alongside the skip verdict", () => {
    const input = {
      sport: "windsurf" as const,
      windMs: 14, // above ideal → offshore scales to skip
      gustMs: 16,
      weatherCode: 0,
      windDirectionDeg: 180,
      shoreBearingDeg: 0,
    };
    expect(computeDecision(input)).toBe("skip");
    expect(decisionReasons(input)).toEqual([
      "wind_above_ideal",
      "offshore_risk",
      "steady_wind",
    ]);
  });

  it("reports overpowering gusts and pre-storm CAPE", () => {
    expect(
      decisionReasons({
        sport: "wingfoil",
        windMs: 9,
        gustMs: 16, // > wingfoil maxMs 15.4
        weatherCode: 0,
        capeJkg: 1500,
      }),
    ).toEqual(["wind_in_ideal_band", "gusts_overpowering", "storm_risk"]);
  });

  it("reports too_light + heavy precip without a shore bearing", () => {
    expect(
      decisionReasons({
        sport: "windsurf",
        windMs: 3,
        gustMs: 4,
        weatherCode: 65,
      }),
    ).toEqual(["too_light", "steady_wind", "heavy_precipitation"]);
  });
});
