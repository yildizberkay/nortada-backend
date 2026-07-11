import type { Spot } from "@/db";

/**
 * Minimal spot geo the weather domain needs (coords + shore bearing + sports),
 * without leaking spot's internal id or curation fields across the boundary.
 */
export interface SpotGeo {
  uid: string;
  latitude: number;
  longitude: number;
  shoreBearingDeg: number | null;
  supportedSports: Spot["supportedSports"];
}
