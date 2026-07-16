import sharp from "sharp";

import type { SpatialGrid } from "@/packages/om-spatial";

import {
  deriveWindComponents,
  encodeScalarLayer,
  encodeWindLayer,
} from "./layer-image";

// Row-major, row 0 = SOUTH (the raw `.om` orientation).
const grid = (data: number[], width = 2, height = 2): SpatialGrid => ({
  width,
  height,
  data: Float32Array.from(data),
});

const U = [1, -1, 2, 0];
const V = [0, 0, 0, 4];
const GUST = [5, 5, 5, 5];

/** Decode the WebP back to raw RGBA — the exact bytes any client sees. */
const decode = async (image: Buffer) => {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  return { data, width: info.width, height: info.height };
};

describe("encodeWindLayer", () => {
  it("emits lossless WebP (VP8L) — the container must never be lossy", async () => {
    const encoded = await encodeWindLayer(grid(U), grid(V), grid(GUST));
    const meta = await sharp(encoded.image).metadata();
    expect(meta.format).toBe("webp");
    // VP8L chunk = lossless bitstream; a lossy frame would decode to
    // DIFFERENT bytes and silently corrupt the wind field.
    expect(encoded.image.includes(Buffer.from("VP8L"))).toBe(true);
  });

  it("round-trips every byte exactly (data texture, not a picture)", async () => {
    // A deliberately noisy 16×16 field so any lossy path would show.
    const size = 16 * 16;
    const noisyU = Array.from(
      { length: size },
      (_, i) => Math.sin(i * 1.7) * 30,
    );
    const noisyV = Array.from(
      { length: size },
      (_, i) => Math.cos(i * 2.3) * 25,
    );
    const noisyG = Array.from({ length: size }, (_, i) => (i % 37) + 0.5);
    const encoded = await encodeWindLayer(
      grid(noisyU, 16, 16),
      grid(noisyV, 16, 16),
      grid(noisyG, 16, 16),
    );
    const image = await decode(encoded.image);
    const s = encoded.scales as {
      uMin: number;
      uMax: number;
      vMin: number;
      vMax: number;
      gustMin: number;
      gustMax: number;
    };
    const byte = (value: number, min: number, max: number) =>
      Math.round(Math.min(Math.max((value - min) / (max - min), 0), 1) * 255);
    for (let row = 0; row < 16; row++) {
      const srcRow = 15 - row;
      for (let col = 0; col < 16; col++) {
        const src = srcRow * 16 + col;
        const dst = (row * 16 + col) * 4;
        // Float32Array storage — quantize the same values the encoder saw.
        const u = Math.fround(noisyU[src]);
        const v = Math.fround(noisyV[src]);
        const g = Math.fround(noisyG[src]);
        expect(image.data[dst]).toBe(byte(u, s.uMin, s.uMax));
        expect(image.data[dst + 1]).toBe(byte(v, s.vMin, s.vMax));
        expect(image.data[dst + 2]).toBe(byte(g, s.gustMin, s.gustMax));
        expect(image.data[dst + 3]).toBe(255);
      }
    }
  });

  it("scales channels to per-frame extremes, u/v symmetric around zero", async () => {
    const encoded = await encodeWindLayer(grid(U), grid(V), grid(GUST));
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

  it("flips rows so texture row 0 is the north edge", async () => {
    const image = await decode(
      (await encodeWindLayer(grid(U), grid(V), grid(GUST))).image,
    );
    // Texture row 0 = source row 1 (north): u = [2, 0] with uMax 2.
    expect(image.data[0]).toBe(255); // u=2 → (2+2)/4 → 255
    expect(image.data[4]).toBe(128); // u=0 → midpoint
    // Texture row 1 = source row 0: u = [1, -1].
    expect(image.data[8]).toBe(191); // u=1 → 3/4 → 191
    expect(image.data[12]).toBe(64); // u=-1 → 1/4 → 64
    // v on texture row 0, col 1: v=4 → 255.
    expect(image.data[5]).toBe(255);
  });

  it("keeps alpha opaque everywhere (alpha is never data)", async () => {
    const image = await decode(
      (await encodeWindLayer(grid(U), grid(V), grid(GUST))).image,
    );
    for (let i = 3; i < image.data.length; i += 4) {
      expect(image.data[i]).toBe(255);
    }
  });

  it("falls back to hypot(u,v) × 1.35 when gust is missing", async () => {
    const encoded = await encodeWindLayer(grid(U), grid(V), null);
    expect(encoded.scales).toMatchObject({ hasRealGust: false });
    // Strongest hypot cell is u=0,v=4 → gustMax = 4 × 1.35 = 5.4.
    expect((encoded.scales as { gustMax: number }).gustMax).toBeCloseTo(5.4, 5);
    const image = await decode(encoded.image);
    // Texture row 0 col 1 (source row 1 col 1): u=0, v=4 → gust byte = 255.
    expect(image.data[6]).toBe(255);
  });

  it("encodes NaN cells as calm and excludes them from the extremes", async () => {
    const encoded = await encodeWindLayer(
      grid([Number.NaN, -1, 2, 0]),
      grid(V),
      grid([Number.NaN, 5, 5, 5]),
    );
    expect(encoded.scales).toMatchObject({ uMax: 2, gustMax: 5 });
    const image = await decode(encoded.image);
    // NaN cell is source row 0 col 0 → texture row 1 col 0; u=0 → midpoint.
    expect(image.data[8]).toBe(128);
    expect(image.data[10]).toBe(0); // gust NaN → 0
  });

  it("survives an all-calm field without dividing by zero", async () => {
    const zeros = () => grid([0, 0, 0, 0]);
    const encoded = await encodeWindLayer(zeros(), zeros(), zeros());
    expect(encoded.scales).toEqual({
      uMin: -1,
      uMax: 1,
      vMin: -1,
      vMax: 1,
      gustMin: 0,
      gustMax: 1,
      hasRealGust: true,
    });
    const image = await decode(encoded.image);
    expect(image.data[0]).toBe(128);
    expect(image.data[2]).toBe(0);
  });

  it("rejects mismatched u/v shapes", async () => {
    await expect(
      encodeWindLayer(grid(U), grid([0, 0], 2, 1), null),
    ).rejects.toThrow(/shapes differ/);
  });

  it("rejects a flattened point list (1-row reduced-Gaussian grid)", async () => {
    // ECMWF IFS HRES ships [1 × N] — a point list, not a raster.
    const strip = grid([1, 2, 3, 4], 4, 1);
    await expect(encodeWindLayer(strip, strip, null)).rejects.toThrow(
      /not a 2D raster/,
    );
  });

  it("rejects a grid past WebP's 16383 px/side container limit", async () => {
    // Dimensions alone must trip the guard BEFORE any buffer allocation.
    const tooWide: SpatialGrid = {
      width: 16384,
      height: 2,
      data: new Float32Array(0),
    };
    await expect(encodeWindLayer(tooWide, tooWide, null)).rejects.toThrow(
      /container limit/,
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
  it("packs the value into R with per-frame min/max scales", async () => {
    // Source row 0 = south: [10, 20]; row 1 = north: [30, 40].
    const encoded = await encodeScalarLayer(grid([10, 20, 30, 40]));
    expect(encoded.scales).toEqual({ min: 10, max: 40 });
    const image = await decode(encoded.image);
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

  it("handles negative ranges (temperature below zero)", async () => {
    const encoded = await encodeScalarLayer(grid([-20, -10, 0, 10]));
    expect(encoded.scales).toEqual({ min: -20, max: 10 });
    const image = await decode(encoded.image);
    expect(image.data[8]).toBe(0); // -20 → min
    expect(image.data[4]).toBe(255); // 10 → max
  });

  it("survives a uniform field (zero precipitation everywhere)", async () => {
    const encoded = await encodeScalarLayer(grid([0, 0, 0, 0]));
    expect(encoded.scales).toEqual({ min: 0, max: 1 });
    const image = await decode(encoded.image);
    expect(image.data[0]).toBe(0);
    expect(image.data[3]).toBe(255);
  });

  it("encodes NaN cells as zero and excludes them from the extremes", async () => {
    const encoded = await encodeScalarLayer(grid([Number.NaN, 20, 30, 40]));
    expect(encoded.scales).toEqual({ min: 20, max: 40 });
    const image = await decode(encoded.image);
    // NaN → value 0 → clamped below min → byte 0 (texture row 1 col 0).
    expect(image.data[8]).toBe(0);
  });

  it("rejects a flattened point list (1-row reduced-Gaussian grid)", async () => {
    await expect(encodeScalarLayer(grid([1, 2, 3, 4], 4, 1))).rejects.toThrow(
      /not a 2D raster/,
    );
  });

  it("rejects a grid whose array doesn't match its dimensions", async () => {
    await expect(encodeScalarLayer(grid([1, 2, 3]))).rejects.toThrow(
      /size mismatch/,
    );
  });
});
