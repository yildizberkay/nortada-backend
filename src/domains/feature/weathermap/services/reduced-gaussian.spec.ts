import type { SpatialGrid } from "@/packages/om-spatial";

import {
  isPointList,
  octahedralRowLengths,
  regridOctahedral,
} from "./reduced-gaussian";

// The smallest octahedral grid, O2: hemisphere rows of 20 and 24 points →
// pole-to-pole [20, 24, 24, 20], 88 points total.
const O2_TOTAL = 88;

const pointList = (data: Float32Array): SpatialGrid => ({
  width: data.length,
  height: 1,
  data,
});

describe("octahedralRowLengths", () => {
  it("resolves the O2 layout", () => {
    expect(octahedralRowLengths(O2_TOTAL)).toEqual([20, 24, 24, 20]);
  });

  it("resolves the O1280 layout (IFS HRES)", () => {
    const rows = octahedralRowLengths(6_599_680);
    expect(rows).toHaveLength(2560);
    expect(rows?.[0]).toBe(20);
    expect(rows?.[1279]).toBe(5136);
    expect(rows?.[1280]).toBe(5136);
    expect(rows?.[2559]).toBe(20);
  });

  it("rejects non-octahedral totals", () => {
    expect(octahedralRowLengths(O2_TOTAL + 1)).toBeNull();
    expect(octahedralRowLengths(1_038_240)).toBeNull(); // 1440×721 raster
  });
});

describe("isPointList", () => {
  it("flags a 1-row strip and accepts a raster", () => {
    expect(isPointList(pointList(new Float32Array(O2_TOTAL)))).toBe(true);
    expect(
      isPointList({ width: 4, height: 2, data: new Float32Array(8) }),
    ).toBe(false);
  });
});

describe("regridOctahedral", () => {
  // Value = source ROW index (north → south), so the raster's row mapping is
  // directly observable.
  const rowStamped = (): SpatialGrid => {
    const rows = [20, 24, 24, 20];
    const data = new Float32Array(O2_TOTAL);
    let i = 0;
    rows.forEach((n, row) => {
      for (let p = 0; p < n; p++) data[i++] = row;
    });
    return pointList(data);
  };

  it("maps north-first source rows onto a south-origin raster", () => {
    const out = regridOctahedral(rowStamped(), 8, 4);
    // Output row 0 = SOUTH → the last source row (3); top row = north (0).
    expect(out.width).toBe(8);
    expect(out.height).toBe(4);
    expect(out.data[0]).toBe(3);
    expect(out.data[3 * 8]).toBe(0);
  });

  it("wraps longitudes (source starts at 0°, output column 0 = 180°W)", () => {
    // Stamp point index within the single-hemisphere-row band so longitude
    // mapping is observable on one row: row 1 (24 pts) values 0..23.
    const rows = [20, 24, 24, 20];
    const data = new Float32Array(O2_TOTAL);
    let i = 0;
    rows.forEach((n, row) => {
      for (let p = 0; p < n; p++) data[i++] = row === 1 ? p : -1;
    });
    const out = regridOctahedral(pointList(data), 24, 4);
    // Output row 2 samples source row 1. Column 0 = 180°W = lon 180° → point
    // index round(180/360×24) = 12; the mid column (lon 0°) → point 0.
    expect(out.data[2 * 24 + 0]).toBe(12);
    expect(out.data[2 * 24 + 12]).toBe(0);
  });

  it("preserves NaN cells", () => {
    const grid = rowStamped();
    grid.data[0] = Number.NaN; // first point of the north polar row (lon 0°)
    const out = regridOctahedral(grid, 8, 4);
    // North → output row 3; lon 0° → column 4 (column 0 = 180°W, 45°/col).
    expect(Number.isNaN(out.data[3 * 8 + 4])).toBe(true);
  });

  it("throws on a non-octahedral point list", () => {
    expect(() =>
      regridOctahedral(pointList(new Float32Array(89)), 8, 4),
    ).toThrow(/not an octahedral grid/);
  });
});
