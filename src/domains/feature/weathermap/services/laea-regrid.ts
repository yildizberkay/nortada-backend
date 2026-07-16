import type { SpatialGrid } from "@/packages/om-spatial";

// Regridding for Lambert-Azimuthal-Equal-Area projected rasters (RFC-0011
// §3/§7). UKMO publishes the UKV 2 km domain in data_spatial as a NATIVE
// LAEA raster (verified live 2026-07-16: zero NaN fringe and r=0.61 vs UKMO
// global under an equirect assumption — the grid axes are projected metres,
// not degrees). The encoders and the client assume equirectangular lat/lon,
// so LAEA models resample onto a regular target grid first.
//
// Method mirrors `reduced-gaussian.ts`: nearest-neighbor (the client's GPU
// samples bilinearly anyway), spherical forward LAEA (Snyder / MathWorld) —
// the exact inverse of Open-Meteo's own projection code
// (`LambertAzimuthalEqualAreaProjection.swift`), whose parameters each spec
// below copies verbatim. Every target cell MUST land inside the source
// domain (the target is an inscribed box — see LAEA_MODELS); an
// out-of-domain cell would encode as fake calm, so it throws instead.
//
// Wind needs no vector rotation: UKMO ships speed + METEOROLOGICAL direction
// (geographic degrees-from-north), which stays valid under resampling —
// `deriveWindComponents` then produces geographic u/v. A future LAEA model
// publishing grid-relative u/v components WOULD need rotation here.

export interface LaeaGridSpec {
  /** Central longitude λ0 (degrees). */
  lambda0Deg: number;
  /** Standard parallel φ1 (degrees). */
  phi1Deg: number;
  /** Sphere radius (metres). */
  radiusM: number;
  /** Source raster dims — must match the fetched grid exactly. */
  nx: number;
  ny: number;
  /** Source cell size (metres). */
  dxM: number;
  dyM: number;
  /** Projected coords of source cell (0,0) — row 0 = SOUTH edge (the `.om`
   * raster convention; y grows northward). */
  originXM: number;
  originYM: number;
  /** Regular lat/lon target raster (row 0 = SOUTH, same convention). */
  target: {
    west: number;
    south: number;
    east: number;
    north: number;
    width: number;
    height: number;
  };
}

/**
 * LAEA models by data_spatial id. Projection + source-grid numbers are
 * copied from Open-Meteo's `UkmoDomain.swift` (verified 2026-07-16); the
 * target raster is ours: 0.02° (~2 km at 55°N longitudinally, slightly
 * coarser than the 2 km source meridionally).
 *
 * The target is the largest lat/lon box INSCRIBED in the projected domain
 * (numerically maximized + full-grid verified 2026-07-16), NOT the domain's
 * lat/lon envelope. The envelope's corners fall outside the LAEA rectangle
 * (14.7% of its cells), and out-of-domain wind encodes as u=v=gust=0 — the
 * map would show FABRICATED dead calm where a coarser model has real data,
 * because the client picks the finest model whose bbox covers the viewport.
 * Inside the inscribed box every cell is real; the trimmed fringe (mostly
 * the strip south of 45.56°N) falls back to ICON-EU / UKMO global.
 * `regridLaea` enforces this at render time: an out-of-domain target cell
 * throws instead of shipping fake calm. (Reclaiming the fringe would need a
 * client-visible "no data" sentinel — alpha 0 — an RFC-0011 contract change.)
 */
export const LAEA_MODELS: Record<string, LaeaGridSpec> = {
  ukmo_uk_deterministic_2km: {
    lambda0Deg: -2.5,
    phi1Deg: 54.9,
    radiusM: 6_371_229,
    nx: 1042,
    ny: 970,
    dxM: 2000,
    dyM: 2000,
    originXM: -1_158_000,
    originYM: -1_036_000,
    target: {
      west: -17.24,
      south: 45.56,
      east: 9.24,
      north: 62.28,
      width: 1324, // (east - west) / 0.02
      height: 836, // (north - south) / 0.02
    },
  },
};

export function laeaSpecFor(modelId: string): LaeaGridSpec | undefined {
  return LAEA_MODELS[modelId];
}

/** The (col, row) source-index map for a spec's target raster, -1 = outside
 * the source domain. Identical for every variable and every frame, so it is
 * computed once per spec and cached for the process lifetime. */
const indexMapCache = new Map<LaeaGridSpec, Int32Array>();

function laeaIndexMap(spec: LaeaGridSpec): Int32Array {
  const cached = indexMapCache.get(spec);
  if (cached) return cached;

  const { target } = spec;
  const lambda0 = (spec.lambda0Deg * Math.PI) / 180;
  const phi1 = (spec.phi1Deg * Math.PI) / 180;
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const map = new Int32Array(target.width * target.height);

  for (let r = 0; r < target.height; r++) {
    // Target row 0 = south (matches the source raster convention).
    const lat =
      target.south +
      ((r + 0.5) * (target.north - target.south)) / target.height;
    const phi = (lat * Math.PI) / 180;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let c = 0; c < target.width; c++) {
      const lon =
        target.west + ((c + 0.5) * (target.east - target.west)) / target.width;
      const dLambda = (lon * Math.PI) / 180 - lambda0;
      // Spherical forward LAEA (MathWorld eq. — same as Open-Meteo's Swift).
      const k = Math.sqrt(
        2 / (1 + sinPhi1 * sinPhi + cosPhi1 * cosPhi * Math.cos(dLambda)),
      );
      const x = spec.radiusM * k * cosPhi * Math.sin(dLambda);
      const y =
        spec.radiusM *
        k *
        (cosPhi1 * sinPhi - sinPhi1 * cosPhi * Math.cos(dLambda));
      const col = Math.round((x - spec.originXM) / spec.dxM);
      const row = Math.round((y - spec.originYM) / spec.dyM);
      map[r * target.width + c] =
        col >= 0 && col < spec.nx && row >= 0 && row < spec.ny
          ? row * spec.nx + col
          : -1;
    }
  }
  indexMapCache.set(spec, map);
  return map;
}

/**
 * Resample a native LAEA raster onto the spec's regular lat/lon target grid
 * (row 0 = SOUTH, the `.om` raster convention the encoders expect). Throws
 * on a source-shape mismatch OR an out-of-domain target cell — a silently
 * changed upstream grid or a drifted spec must fail the hour loudly, never
 * ship a mis-georeferenced frame or fabricated-calm cells.
 */
export function regridLaea(grid: SpatialGrid, spec: LaeaGridSpec): SpatialGrid {
  if (grid.width !== spec.nx || grid.height !== spec.ny) {
    throw new Error(
      `LAEA source grid ${grid.width}×${grid.height} does not match the spec's ${spec.nx}×${spec.ny} — upstream grid changed, refusing to regrid`,
    );
  }
  const { width, height } = spec.target;
  const map = laeaIndexMap(spec);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const src = map[i];
    if (src === -1) {
      throw new Error(
        `LAEA target cell ${i} falls outside the source domain — the spec's target box must stay inscribed in the projected rectangle`,
      );
    }
    out[i] = grid.data[src];
  }
  return { width, height, data: out };
}
