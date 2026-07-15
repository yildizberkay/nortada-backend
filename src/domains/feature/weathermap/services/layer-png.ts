import { PNG } from "pngjs";

import type { SpatialGrid } from "@/packages/om-spatial";

// PNG packing for weather-map layers (RFC-0011 §7). Shared rules for every
// layer kind:
//   channel byte = round((value - min) / (max - min) * 255)
//   A = 255 always (alpha is NEVER data — premultiplied decoders must not be
//   able to corrupt the channels), row 0 = NORTH edge (the `.om` grids are
//   south-origin and get flipped here).
//   NaN cells (outside a model's domain) encode as the layer's zero.
// Scales are per-frame (each texture normalizes to its own extremes for full
// 8-bit range) and travel in the manifest for decoding.
//
// Kinds:
//   wind   — R = u (west→east m/s), G = v (south→north m/s), B = gust (m/s);
//            u/v scales symmetric around zero. Byte-for-byte the iOS POC
//            contract (`tools/wind-encoder/generate.py` in the app repo).
//   scalar — R = value, G = B = 0; {min, max} scales.
// A new packing kind = one encoder here + a dispatch case in the service.

/** Gust ≈ speed × 1.35 when the file has no gust field (T+0 analysis). */
const GUST_FALLBACK_FACTOR = 1.35;

export interface WindScales {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  gustMin: number;
  gustMax: number;
  /** False = the B channel is hypot(u, v) × 1.35 (file lacked gust). */
  hasRealGust: boolean;
}

export interface ScalarScales {
  min: number;
  max: number;
}

export type LayerScales = WindScales | ScalarScales;

export interface EncodedLayerPng {
  png: Buffer;
  width: number;
  height: number;
  scales: LayerScales;
}

/**
 * Derive u/v components from speed + METEOROLOGICAL direction (the bearing
 * the wind blows FROM) for models that don't publish components:
 * u = -speed·sin(θ), v = -speed·cos(θ). NaN in either input → NaN out (the
 * encoder's NaN handling then applies).
 */
export function deriveWindComponents(
  speed: SpatialGrid,
  direction: SpatialGrid,
): { u: SpatialGrid; v: SpatialGrid } {
  if (
    speed.width !== direction.width ||
    speed.height !== direction.height ||
    speed.data.length !== direction.data.length
  ) {
    throw new Error(
      `speed/direction grid shapes differ: ${speed.width}×${speed.height} vs ${direction.width}×${direction.height}`,
    );
  }
  const size = speed.data.length;
  const u = new Float32Array(size);
  const v = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const radians = (direction.data[i] * Math.PI) / 180;
    u[i] = -speed.data[i] * Math.sin(radians);
    v[i] = -speed.data[i] * Math.cos(radians);
  }
  return {
    u: { width: speed.width, height: speed.height, data: u },
    v: { width: speed.width, height: speed.height, data: v },
  };
}

/** Encode the wind layer (u + v required, gust optional) — R/G/B packing. */
export function encodeWindLayer(
  u: SpatialGrid,
  v: SpatialGrid,
  gust: SpatialGrid | null,
): EncodedLayerPng {
  const { width, height } = u;
  if (v.width !== width || v.height !== height) {
    throw new Error(
      `wind grid shapes differ: u=${width}×${height} v=${v.width}×${v.height}`,
    );
  }
  const size = width * height;
  assertSize("u", u, size);
  assertSize("v", v, size);
  const hasRealGust = gust !== null && gust.data.length === size;

  // Per-frame extremes over finite cells only. Guard against an all-calm (or
  // all-NaN) field: a zero span would divide by zero, so floor the span at 1.
  let uAbsMax = 0;
  let vAbsMax = 0;
  let gustMax = 0;
  for (let i = 0; i < size; i++) {
    const uVal = u.data[i];
    const vVal = v.data[i];
    if (Number.isFinite(uVal) && Math.abs(uVal) > uAbsMax) {
      uAbsMax = Math.abs(uVal);
    }
    if (Number.isFinite(vVal) && Math.abs(vVal) > vAbsMax) {
      vAbsMax = Math.abs(vVal);
    }
    const gustVal = hasRealGust
      ? (gust as SpatialGrid).data[i]
      : Math.hypot(uVal, vVal) * GUST_FALLBACK_FACTOR;
    if (Number.isFinite(gustVal) && gustVal > gustMax) {
      gustMax = gustVal;
    }
  }
  uAbsMax = uAbsMax || 1;
  vAbsMax = vAbsMax || 1;
  gustMax = gustMax || 1;

  const scales: WindScales = {
    uMin: -uAbsMax,
    uMax: uAbsMax,
    vMin: -vAbsMax,
    vMax: vAbsMax,
    gustMin: 0,
    gustMax,
    hasRealGust,
  };

  const png = new PNG({ width, height });
  const out = png.data;
  for (let row = 0; row < height; row++) {
    // Source row 0 = south; texture row 0 = north.
    const srcRow = height - 1 - row;
    for (let col = 0; col < width; col++) {
      const src = srcRow * width + col;
      const dst = (row * width + col) * 4;
      const uVal = Number.isFinite(u.data[src]) ? u.data[src] : 0;
      const vVal = Number.isFinite(v.data[src]) ? v.data[src] : 0;
      let gustVal = hasRealGust
        ? (gust as SpatialGrid).data[src]
        : Math.hypot(uVal, vVal) * GUST_FALLBACK_FACTOR;
      if (!Number.isFinite(gustVal)) gustVal = 0;
      out[dst] = encodeChannel(uVal, scales.uMin, scales.uMax);
      out[dst + 1] = encodeChannel(vVal, scales.vMin, scales.vMax);
      out[dst + 2] = encodeChannel(gustVal, scales.gustMin, scales.gustMax);
      out[dst + 3] = 255;
    }
  }

  return { png: PNG.sync.write(png), width, height, scales };
}

/** Encode a single-variable layer (temperature, precipitation, …) into R. */
export function encodeScalarLayer(grid: SpatialGrid): EncodedLayerPng {
  const { width, height } = grid;
  const size = width * height;
  assertSize("scalar", grid, size);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < size; i++) {
    const value = grid.data[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  // All-NaN field → encode as a zero field with a unit span.
  if (min > max) {
    min = 0;
    max = 1;
  }
  // Uniform field (e.g. zero precipitation everywhere) → unit span so the
  // division below is defined; every byte lands on `min`.
  if (min === max) max = min + 1;

  const scales: ScalarScales = { min, max };

  const png = new PNG({ width, height });
  const out = png.data;
  for (let row = 0; row < height; row++) {
    const srcRow = height - 1 - row;
    for (let col = 0; col < width; col++) {
      const src = srcRow * width + col;
      const dst = (row * width + col) * 4;
      const raw = grid.data[src];
      const value = Number.isFinite(raw) ? raw : 0;
      out[dst] = encodeChannel(value, min, max);
      out[dst + 1] = 0;
      out[dst + 2] = 0;
      out[dst + 3] = 255;
    }
  }

  return { png: PNG.sync.write(png), width, height, scales };
}

function assertSize(name: string, grid: SpatialGrid, size: number): void {
  if (grid.data.length !== size) {
    throw new Error(
      `${name} grid size mismatch: ${grid.width}×${grid.height} vs data=${grid.data.length}`,
    );
  }
}

function encodeChannel(value: number, min: number, max: number): number {
  const t = (value - min) / (max - min);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.round(clamped * 255);
}
