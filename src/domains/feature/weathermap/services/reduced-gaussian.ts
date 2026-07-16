import type { SpatialGrid } from "@/packages/om-spatial";

// Regridding for reduced-Gaussian point lists (RFC-0011 §7). ECMWF publishes
// IFS HRES in data_spatial on its native octahedral O1280 grid, flattened to
// a `[1 × 6,599,680]` point list instead of a lat/lon raster — unusable by
// the PNG encoders as-is. The octahedral layout is deterministic (hemisphere
// row i, 1-based from the pole, holds 16 + 4·i points), so the point list
// regrids onto a regular raster with plain index math and no coordinate
// arrays. Layout verified empirically 2026-07-16: rows run north → south,
// each row's longitudes start at 0° (Greenwich) heading east, and the
// regridded field correlates r = 0.9999 with the same run's regular-grid
// `ecmwf_ifs025` product.
//
// Sampling is nearest-neighbor in both axes (the client's GPU samples the
// texture bilinearly anyway) and Gaussian latitudes are approximated as
// uniformly spaced — for O1280 the true Gaussian spacing differs from
// uniform by far less than an output pixel.

/**
 * Points per row (pole → pole) of the octahedral O-N grid whose total point
 * count is `total`, or null when `total` is not an octahedral count. O1280
 * (IFS HRES) → 2560 rows of 20…5136 points summing to 6,599,680.
 */
export function octahedralRowLengths(total: number): number[] | null {
  for (let n = 2; n <= 8192; n++) {
    const hemisphere = 16 * n + 4 * ((n * (n + 1)) / 2);
    if (2 * hemisphere === total) {
      const rows: number[] = [];
      for (let i = 1; i <= n; i++) rows.push(16 + 4 * i);
      for (let i = n; i >= 1; i--) rows.push(16 + 4 * i);
      return rows;
    }
    if (2 * hemisphere > total) return null;
  }
  return null;
}

/** True when a fetched grid is a flattened point list, not a raster. */
export function isPointList(grid: SpatialGrid): boolean {
  return grid.height === 1 && grid.width > 1;
}

/**
 * Resample an octahedral reduced-Gaussian point list onto a regular
 * lat/lon raster in the `.om` raster convention the encoders expect:
 * row 0 = SOUTH edge, column 0 = 180°W, global coverage. Throws when the
 * point count is not octahedral — the caller treats that as a model-level
 * error (a new exotic layout must fail loudly, not ship garbage).
 */
export function regridOctahedral(
  grid: SpatialGrid,
  width: number,
  height: number,
): SpatialGrid {
  const rows = octahedralRowLengths(grid.data.length);
  if (!rows) {
    throw new Error(
      `point list of ${grid.data.length} cells is not an octahedral grid — cannot regrid`,
    );
  }
  const offsets: number[] = [0];
  for (const n of rows) offsets.push(offsets[offsets.length - 1] + n);

  const out = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    // Output row 0 = south; source rows run north → south.
    const lat = -90 + ((r + 0.5) * 180) / height;
    let gaussianRow = Math.round(((90 - lat) / 180) * rows.length - 0.5);
    if (gaussianRow < 0) gaussianRow = 0;
    if (gaussianRow >= rows.length) gaussianRow = rows.length - 1;
    const rowPoints = rows[gaussianRow];
    const base = offsets[gaussianRow];
    for (let c = 0; c < width; c++) {
      // Output column 0 = 180°W; source longitudes start at 0° heading east.
      let lon = -180 + (c * 360) / width;
      if (lon < 0) lon += 360;
      const idx = Math.round((lon / 360) * rowPoints) % rowPoints;
      out[r * width + c] = grid.data[base + idx];
    }
  }
  return { width, height, data: out };
}
