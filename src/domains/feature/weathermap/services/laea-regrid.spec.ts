import type { SpatialGrid } from "@/packages/om-spatial";

import { LAEA_MODELS, laeaSpecFor, regridLaea } from "./laea-regrid";

const spec = LAEA_MODELS.ukmo_uk_deterministic_2km;

const sourceOf = (fill: (i: number) => number): SpatialGrid => {
  const data = new Float32Array(spec.nx * spec.ny);
  for (let i = 0; i < data.length; i++) data[i] = fill(i);
  return { width: spec.nx, height: spec.ny, data };
};

describe("laea-regrid", () => {
  it("resolves specs by model id", () => {
    expect(laeaSpecFor("ukmo_uk_deterministic_2km")).toBe(spec);
    expect(laeaSpecFor("dwd_icon")).toBeUndefined();
  });

  it("produces the spec's target raster dimensions", () => {
    const out = regridLaea(
      sourceOf(() => 1),
      spec,
    );
    expect(out.width).toBe(spec.target.width);
    expect(out.height).toBe(spec.target.height);
  });

  it("maps the projection center onto the correct source cell", () => {
    // Encode each source index as its own value, then look up the target
    // cell whose center is nearest the projection center (54.9°N 2.5°W).
    // Hand-derived expectation: x≈639 m, y≈1112 m off the projection
    // origin → source col 579, row 519 (values fit float32 exactly).
    const out = regridLaea(
      sourceOf((i) => i),
      spec,
    );
    const t = spec.target;
    const row = Math.floor(
      ((54.91 - t.south) / (t.north - t.south)) * t.height,
    );
    const col = Math.floor(((-2.49 - t.west) / (t.east - t.west)) * t.width);
    const sourceIndex = out.data[row * t.width + col];
    expect(Math.floor(sourceIndex / spec.nx)).toBe(519);
    expect(sourceIndex % spec.nx).toBe(579);
  });

  it("marks target cells outside the projected source domain as NaN", () => {
    const out = regridLaea(
      sourceOf(() => 1),
      spec,
    );
    const t = spec.target;
    // The lat/lon bbox is the projected rectangle's envelope, so parts of
    // the target raster fall outside the source domain (the SE corner
    // does); the center is comfortably inside.
    expect(out.data[t.width - 1]).toBeNaN(); // SE corner (row 0 = south)
    expect(
      out.data[Math.floor(t.height / 2) * t.width + Math.floor(t.width / 2)],
    ).toBe(1);
    const nanShare =
      [...out.data].filter((v) => !Number.isFinite(v)).length / out.data.length;
    expect(nanShare).toBeGreaterThan(0.05);
    expect(nanShare).toBeLessThan(0.3);
  });

  it("throws on a source-shape mismatch instead of mis-georeferencing", () => {
    const wrong: SpatialGrid = {
      width: spec.nx - 1,
      height: spec.ny,
      data: new Float32Array((spec.nx - 1) * spec.ny),
    };
    expect(() => regridLaea(wrong, spec)).toThrow(/does not match/);
  });
});
