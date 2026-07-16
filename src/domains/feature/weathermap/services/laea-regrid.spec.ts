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

  it("covers EVERY target cell with real source data (inscribed box)", () => {
    // The target box is inscribed in the projected domain, so no cell may
    // fall outside it — an out-of-domain cell would encode as u=v=gust=0
    // and the map would show fabricated dead calm over e.g. Biscay while a
    // coarser model has real wind there. regridLaea throws on any -1, so a
    // clean full-raster pass IS the zero-fake-cells guarantee.
    const out = regridLaea(
      sourceOf(() => 1),
      spec,
    );
    expect(out.data.length).toBe(spec.target.width * spec.target.height);
    expect([...out.data].every((v) => v === 1)).toBe(true);
  });

  it("throws (never fabricates calm) when the target box leaves the domain", () => {
    // The old envelope box had ~14.7% of its cells outside the projected
    // rectangle — that spec shape must now fail loudly at render time.
    const envelope = {
      ...spec,
      target: {
        west: -17.16,
        south: 44.5,
        east: 15.36,
        north: 61.94,
        width: 1626,
        height: 872,
      },
    };
    expect(() => regridLaea(sourceOf(() => 1), envelope)).toThrow(
      /outside the source domain/,
    );
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
