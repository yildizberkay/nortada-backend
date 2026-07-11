import {
  bestWindow,
  computeConfidence,
  computeDecision,
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
  });

  it("finds the soonest contiguous go-run", () => {
    // hours: light, GO, GO, light...
    const w = bestWindow(series([3, 10, 11, 3, 3]), "windsurf", null);
    expect(w).not.toBeNull();
    expect(w?.start).toBe("2026-07-11T01:00");
    expect(w?.end).toBe("2026-07-11T02:00");
    expect(w?.peakWindMs).toBe(11);
  });

  it("returns null when nothing is suitable", () => {
    expect(bestWindow(series([2, 2, 2]), "windsurf", null)).toBeNull();
  });
});
