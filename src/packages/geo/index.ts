// Plain-Postgres geo helpers (no PostGIS — D-003). The repository does the
// haversine ordering in SQL; these pure functions back the bbox pre-filter, the
// wind-vs-shore classification, and the unit tests.

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEG_LAT = 111.32;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export interface BoundingBox {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/**
 * Latitude/longitude window that fully contains a `radiusKm` circle around a
 * point — the cheap index-friendly pre-filter before the exact haversine pass.
 * Longitude degrees shrink with latitude (÷cos φ); clamped near the poles.
 */
export function boundingBox(
  lat: number,
  lon: number,
  radiusKm: number,
): BoundingBox {
  const latDelta = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.cos(toRad(lat));
  // Guard the pole singularity: fall back to a full longitude span.
  const lonDelta =
    Math.abs(cosLat) < 1e-6 ? 180 : radiusKm / (KM_PER_DEG_LAT * cosLat);
  return {
    // Latitude clamps hard (can't wrap past the poles).
    latMin: Math.max(-90, lat - latDelta),
    latMax: Math.min(90, lat + latDelta),
    // Longitude may spill past ±180; the ranges below handle the wrap.
    lonMin: lon - lonDelta,
    lonMax: lon + lonDelta,
  };
}

/**
 * Split a possibly-out-of-range [lonMin, lonMax] into 1–2 in-range
 * [min, max] segments, wrapping across the antimeridian (±180°). A query near
 * 179.9° then still matches a spot at −179.9°. The repository ORs these into
 * its longitude predicate.
 */
export function longitudeRanges(
  lonMin: number,
  lonMax: number,
): Array<[number, number]> {
  // Radius already spans the whole globe longitudinally (near a pole).
  if (lonMin <= -180 && lonMax >= 180) return [[-180, 180]];
  if (lonMin < -180) {
    return [
      [-180, lonMax],
      [lonMin + 360, 180],
    ];
  }
  if (lonMax > 180) {
    return [
      [lonMin, 180],
      [-180, lonMax - 360],
    ];
  }
  return [[lonMin, lonMax]];
}

/** Great-circle distance in km between two lat/lon points. */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export type WindSide =
  | "onshore"
  | "cross-onshore"
  | "cross-shore"
  | "cross-offshore"
  | "offshore";

/**
 * Classify a wind relative to a spot's shore. `shoreBearingDeg` is the outward
 * normal (shore → open water); `windFromDeg` is the meteorological direction
 * the wind blows FROM. Wind arriving from the water side is onshore; from the
 * land side, offshore (blows the rider out to sea — the dangerous case).
 */
export function windSide(
  shoreBearingDeg: number,
  windFromDeg: number,
): WindSide {
  const norm = (d: number) => ((d % 360) + 360) % 360;
  let diff = Math.abs(norm(windFromDeg) - norm(shoreBearingDeg));
  if (diff > 180) diff = 360 - diff;

  if (diff <= 22.5) return "onshore";
  if (diff <= 67.5) return "cross-onshore";
  if (diff <= 112.5) return "cross-shore";
  if (diff <= 157.5) return "cross-offshore";
  return "offshore";
}
