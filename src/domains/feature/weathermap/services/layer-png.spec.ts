import { PNG } from "pngjs";

import type { SpatialGrid } from "@/packages/om-spatial";

import {
  deriveWindComponents,
  encodeScalarLayer,
  encodeWindLayer,
} from "./layer-png";

// Row-major, row 0 = SOUTH (the raw `.om` orientation).
const grid = (data: number[], width = 2, height = 2): SpatialGrid => ({
  width,
  height,
  data: Float32Array.from(data),
});

const U = [1, -1, 2, 0];
const V = [0, 0, 0, 4];
const GUST = [5, 5, 5, 5];

const decode = (png: Buffer) => PNG.sync.read(png);

describe("encodeWindLayer", () => {
  it("scales channels to per-frame extremes, u/v symmetric around zero", () => {
    const encoded = encodeWindLayer(grid(U), grid(V), grid(GUST));
    expect(encoded.scales).toEqual({
      uMin: -2,
      uMax: 2,
      vMin: -4,
      vMax: 4,
      gustMin: 0,
      gustMax: 5,
      hasRealGust: true,
    });
    expect(encoded.width).toBe(2);
    expect(encoded.height).toBe(2);
  });

  it("flips rows so texture row 0 is the north edge", () => {
    const image = decode(encodeWindLayer(grid(U), grid(V), grid(GUST)).png);
    // Texture row 0 = source row 1 (north): u = [2, 0] with uMax 2.
    expect(image.data[0]).toBe(255); // u=2 → (2+2)/4 → 255
    expect(image.data[4]).toBe(128); // u=0 → midpoint
    // Texture row 1 = source row 0: u = [1, -1].
    expect(image.data[8]).toBe(191); // u=1 → 3/4 → 191
    expect(image.data[12]).toBe(64); // u=-1 → 1/4 → 64
    // v on texture row 0, col 1: v=4 → 255.
    expect(image.data[5]).toBe(255);
  });

  it("keeps alpha opaque everywhere (alpha is never data)", () => {
    const image = decode(encodeWindLayer(grid(U), grid(V), grid(GUST)).png);
    for (let i = 3; i < image.data.length; i += 4) {
      expect(image.data[i]).toBe(255);
    }
  });

  it("falls back to hypot(u,v) × 1.35 when gust is missing", () => {
    const encoded = encodeWindLayer(grid(U), grid(V), null);
    expect(encoded.scales).toMatchObject({ hasRealGust: false });
    // Strongest hypot cell is u=0,v=4 → gustMax = 4 × 1.35 = 5.4.
    expect((encoded.scales as { gustMax: number }).gustMax).toBeCloseTo(5.4, 5);
    const image = decode(encoded.png);
    // Texture row 0 col 1 (source row 1 col 1): u=0, v=4 → gust byte = 255.
    expect(image.data[6]).toBe(255);
  });

  it("encodes NaN cells as calm and excludes them from the extremes", () => {
    const encoded = encodeWindLayer(
      grid([Number.NaN, -1, 2, 0]),
      grid(V),
      grid([Number.NaN, 5, 5, 5]),
    );
    expect(encoded.scales).toMatchObject({ uMax: 2, gustMax: 5 });
    const image = decode(encoded.png);
    // NaN cell is source row 0 col 0 → texture row 1 col 0; u=0 → midpoint.
    expect(image.data[8]).toBe(128);
    expect(image.data[10]).toBe(0); // gust NaN → 0
  });

  it("survives an all-calm field without dividing by zero", () => {
    const zeros = () => grid([0, 0, 0, 0]);
    const encoded = encodeWindLayer(zeros(), zeros(), zeros());
    expect(encoded.scales).toEqual({
      uMin: -1,
      uMax: 1,
      vMin: -1,
      vMax: 1,
      gustMin: 0,
      gustMax: 1,
      hasRealGust: true,
    });
    const image = decode(encoded.png);
    expect(image.data[0]).toBe(128);
    expect(image.data[2]).toBe(0);
  });

  it("rejects mismatched u/v shapes", () => {
    expect(() => encodeWindLayer(grid(U), grid([0, 0], 2, 1), null)).toThrow(
      /shapes differ/,
    );
  });
});

describe("deriveWindComponents", () => {
  it("converts speed + meteorological direction to u/v", () => {
    // Direction = where the wind blows FROM: 90° (east) → u = -speed, v ≈ 0;
    // 0° (north) → v = -speed; 180° (south) → v = +speed.
    const { u, v } = deriveWindComponents(
      grid([10, 10, 10, 10]),
      grid([90, 0, 180, 270]),
    );
    expect(u.data[0]).toBeCloseTo(-10, 4);
    expect(v.data[0]).toBeCloseTo(0, 4);
    expect(v.data[1]).toBeCloseTo(-10, 4);
    expect(v.data[2]).toBeCloseTo(10, 4);
    expect(u.data[3]).toBeCloseTo(10, 4); // from west → blowing east
  });

  it("propagates NaN so the encoder's NaN handling applies", () => {
    const { u } = deriveWindComponents(
      grid([Number.NaN, 5, 5, 5]),
      grid([90, 90, 90, 90]),
    );
    expect(Number.isNaN(u.data[0])).toBe(true);
  });

  it("rejects mismatched shapes", () => {
    expect(() =>
      deriveWindComponents(grid([1, 2, 3, 4]), grid([0, 0], 2, 1)),
    ).toThrow(/shapes differ/);
  });
});

describe("encodeScalarLayer", () => {
  it("packs the value into R with per-frame min/max scales", () => {
    // Source row 0 = south: [10, 20]; row 1 = north: [30, 40].
    const encoded = encodeScalarLayer(grid([10, 20, 30, 40]));
    expect(encoded.scales).toEqual({ min: 10, max: 40 });
    const image = decode(encoded.png);
    // Texture row 0 = north: values 30, 40.
    expect(image.data[0]).toBe(170); // (30-10)/30 → 170
    expect(image.data[4]).toBe(255); // 40 → max
    // Texture row 1 = south: values 10, 20.
    expect(image.data[8]).toBe(0); // 10 → min
    expect(image.data[12]).toBe(85); // (20-10)/30 → 85
    // G/B unused, alpha opaque.
    expect(image.data[1]).toBe(0);
    expect(image.data[2]).toBe(0);
    expect(image.data[3]).toBe(255);
  });

  it("handles negative ranges (temperature below zero)", () => {
    const encoded = encodeScalarLayer(grid([-20, -10, 0, 10]));
    expect(encoded.scales).toEqual({ min: -20, max: 10 });
    const image = decode(encoded.png);
    expect(image.data[8]).toBe(0); // -20 → min
    expect(image.data[4]).toBe(255); // 10 → max
  });

  it("survives a uniform field (zero precipitation everywhere)", () => {
    const encoded = encodeScalarLayer(grid([0, 0, 0, 0]));
    expect(encoded.scales).toEqual({ min: 0, max: 1 });
    const image = decode(encoded.png);
    expect(image.data[0]).toBe(0);
    expect(image.data[3]).toBe(255);
  });

  it("encodes NaN cells as zero and excludes them from the extremes", () => {
    const encoded = encodeScalarLayer(grid([Number.NaN, 20, 30, 40]));
    expect(encoded.scales).toEqual({ min: 20, max: 40 });
    const image = decode(encoded.png);
    // NaN → value 0 → clamped below min → byte 0 (texture row 1 col 0).
    expect(image.data[8]).toBe(0);
  });

  it("rejects a grid whose array doesn't match its dimensions", () => {
    expect(() => encodeScalarLayer(grid([1, 2, 3]))).toThrow(/size mismatch/);
  });
});
