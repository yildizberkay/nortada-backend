// Weather-map layer registry (RFC-0011 §7). A layer = which `.om` variables
// feed it + how they pack into PNG channels. ADDING A LAYER IS ONE ENTRY HERE
// — the pipeline (due-check, render, keys, manifest, pruning) is layer-generic
// and the DB schema never changes. Two packing kinds exist today:
//   "wind"   — u/v/gust → R/G/B (the special 3-variable case)
//   "scalar" — one variable → R (G/B zero), min/max scales
// A future kind (e.g. two-variable wave height+direction) = one new encoder in
// `services/layer-png.ts` + a case in the service's `encodeLayer` dispatch.
//
// Per-invocation narrowing (force-run task payload / CLI --layers) can only
// select among enabled entries.

interface WeatherMapLayerBase {
  /** Public id — appears in the API, object keys, and DB rows. */
  id: string;
  label: string;
  /** Unit of the DECODED values (after applying the manifest scales). */
  unit: string;
  enabled: boolean;
}

export interface WindLayer extends WeatherMapLayerBase {
  kind: "wind";
}

export interface ScalarLayer extends WeatherMapLayerBase {
  kind: "scalar";
  /** The `.om` variable. A file without it skips this layer-frame silently. */
  variable: string;
}

export type WeatherMapLayer = WindLayer | ScalarLayer;

export const WIND_U_VARIABLE = "wind_u_component_10m";
export const WIND_V_VARIABLE = "wind_v_component_10m";
export const WIND_GUST_VARIABLE = "wind_gusts_10m";
// Several models (GeoSphere, ItaliaMeteo, KNMI, DMI, MET Norway — verified
// 2026-07-15) publish 10 m wind as speed + meteorological direction instead
// of u/v components; the encoder derives u/v from these when u/v are absent.
export const WIND_SPEED_VARIABLE = "wind_speed_10m";
export const WIND_DIRECTION_VARIABLE = "wind_direction_10m";

export const WEATHER_MAP_LAYERS: readonly WeatherMapLayer[] = [
  { id: "wind", kind: "wind", label: "Wind", unit: "m/s", enabled: true },
  {
    id: "temperature",
    kind: "scalar",
    variable: "temperature_2m",
    label: "Temperature",
    unit: "°C",
    enabled: true,
  },
  {
    id: "precipitation",
    kind: "scalar",
    variable: "precipitation",
    label: "Precipitation",
    unit: "mm",
    enabled: true,
  },
  // Not every model/season publishes snowfall (verified absent in the July
  // ICON-EU run) — those frames skip gracefully and the layer's manifest
  // stays empty for that model.
  {
    id: "snowfall",
    kind: "scalar",
    variable: "snowfall",
    label: "Snowfall",
    unit: "cm",
    enabled: true,
  },
];

/**
 * `.om` variables a layer reads. Wind requests both namings (u/v and
 * speed/direction) — whichever the file lacks is simply absent from the
 * result; gust is optional everywhere (see encoder).
 */
export function layerVariables(layer: WeatherMapLayer): string[] {
  return layer.kind === "wind"
    ? [
        WIND_U_VARIABLE,
        WIND_V_VARIABLE,
        WIND_GUST_VARIABLE,
        WIND_SPEED_VARIABLE,
        WIND_DIRECTION_VARIABLE,
      ]
    : [layer.variable];
}

/** The active set: enabled registry entries, optionally narrowed by env csv. */
export function activeWeatherMapLayers(narrowTo?: string[]): WeatherMapLayer[] {
  const enabled = WEATHER_MAP_LAYERS.filter((l) => l.enabled);
  if (!narrowTo || narrowTo.length === 0) return enabled;
  const wanted = new Set(narrowTo);
  return enabled.filter((l) => wanted.has(l.id));
}

export function findWeatherMapLayer(id: string): WeatherMapLayer | undefined {
  return WEATHER_MAP_LAYERS.find((l) => l.id === id);
}
