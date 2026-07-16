// Weather-map model registry (RFC-0011 §7). Static and code-reviewed: ids are
// Open-Meteo `data_spatial` directory names, verified live 2026-07-15. The
// user-selected major-model set plus verified recommendations. `enabled` is
// the default; per-invocation narrowing (force-run payload / CLI --models)
// can only select among enabled entries, never resurrect a disabled one.
//
// Evaluated and rejected (not registry entries — do not re-add without
// re-verifying):
// - `ncep_gfs025` (GFS 0.25°): data_spatial files carry pressure-level fields
//   only — no 10 m wind, no 2 m temperature (verified 2026-07-15). GFS 0.13°
//   covers the family with surface fields at higher resolution. The 0.25°
//   files become relevant only if we ever ship an upper-air layer.

export interface WeatherMapModel {
  /** `data_spatial` model id — also the public id in the API + object keys. */
  id: string;
  label: string;
  provider: string;
  /** Approximate native grid resolution, for the client's model picker. */
  resolutionKm: number;
  enabled: boolean;
}

export const WEATHER_MAP_MODELS: readonly WeatherMapModel[] = [
  {
    id: "dwd_icon",
    label: "ICON",
    provider: "DWD",
    resolutionKm: 11,
    enabled: true,
  },
  {
    id: "dwd_icon_eu",
    label: "ICON-EU",
    provider: "DWD",
    resolutionKm: 6.5,
    enabled: true,
  },
  {
    id: "dwd_icon_d2",
    label: "ICON-D2",
    provider: "DWD",
    resolutionKm: 2.2,
    enabled: true,
  },
  // Published as the native O1280 reduced-Gaussian POINT LIST (the .om grid
  // is [1 × 6,599,680]), not a lat/lon raster — resampled onto a regular
  // 0.1° grid by `reduced-gaussian.ts` before encoding (RFC-0011 §7).
  {
    id: "ecmwf_ifs",
    label: "IFS HRES",
    provider: "ECMWF",
    resolutionKm: 9,
    enabled: true,
  },
  {
    id: "ecmwf_ifs025",
    label: "IFS 0.25°",
    provider: "ECMWF",
    resolutionKm: 25,
    enabled: true,
  },
  {
    id: "geosphere_arome_austria",
    label: "AROME Austria",
    provider: "GeoSphere",
    resolutionKm: 1,
    enabled: true,
  },
  {
    id: "italia_meteo_arpae_icon_2i",
    label: "ICON-2I",
    provider: "ItaliaMeteo ARPAE",
    resolutionKm: 2.2,
    enabled: true,
  },
  {
    id: "jma_gsm",
    label: "GSM 0.5°",
    provider: "JMA",
    resolutionKm: 55,
    enabled: true,
  },
  {
    id: "jma_msm",
    label: "MSM 0.05°",
    provider: "JMA",
    resolutionKm: 5,
    enabled: true,
  },
  {
    id: "ncep_gfs013",
    label: "GFS 0.13°",
    provider: "NOAA NCEP",
    resolutionKm: 13,
    enabled: true,
  },
  {
    id: "meteofrance_arpege_world025",
    label: "ARPEGE World",
    provider: "Météo-France",
    resolutionKm: 25,
    enabled: true,
  },
  {
    id: "meteofrance_arpege_europe",
    label: "ARPEGE Europe",
    provider: "Météo-France",
    resolutionKm: 11,
    enabled: true,
  },
  {
    id: "meteofrance_arome_france_hd",
    label: "AROME France HD",
    provider: "Météo-France",
    resolutionKm: 1.5,
    enabled: true,
  },
  {
    id: "knmi_harmonie_arome_europe",
    label: "Harmonie AROME",
    provider: "KNMI",
    resolutionKm: 2,
    enabled: true,
  },
  {
    id: "dmi_harmonie_arome_europe",
    label: "Harmonie AROME",
    provider: "DMI",
    resolutionKm: 2,
    enabled: true,
  },
  {
    id: "ncep_hrrr_conus",
    label: "HRRR",
    provider: "NOAA NCEP",
    resolutionKm: 3,
    enabled: true,
  },
  {
    id: "metno_nordic_pp",
    label: "MET Nordic",
    provider: "MET Norway",
    resolutionKm: 1,
    enabled: true,
  },
  {
    id: "meteoswiss_icon_ch1",
    label: "ICON-CH1",
    provider: "MeteoSwiss",
    resolutionKm: 1,
    enabled: true,
  },
  {
    id: "meteoswiss_icon_ch2",
    label: "ICON-CH2",
    provider: "MeteoSwiss",
    resolutionKm: 2,
    enabled: true,
  },
  // Regular lat/lon global grid (2560×1920, 0.141°×0.094°, verified live
  // 2026-07-16); publishes 10 m wind as speed+direction — the encoder's
  // derive-u/v path (KNMI/DMI pattern) covers it.
  {
    id: "ukmo_global_deterministic_10km",
    label: "UKMO Global 10 km",
    provider: "UK Met Office",
    resolutionKm: 10,
    enabled: true,
  },
  // Published as a NATIVE Lambert-Azimuthal projected raster, not lat/lon
  // (verified live 2026-07-16: zero NaN fringe + r=0.61 vs UKMO global under
  // an equirect assumption) — `laea-regrid.ts` resamples it onto a regular
  // 0.02° lat/lon grid before the shared encode path (RFC-0011 §3/§7).
  {
    id: "ukmo_uk_deterministic_2km",
    label: "UKV",
    provider: "UK Met Office",
    resolutionKm: 2,
    enabled: true,
  },
];

/** The active set: enabled registry entries, optionally narrowed by env csv. */
export function activeWeatherMapModels(narrowTo?: string[]): WeatherMapModel[] {
  const enabled = WEATHER_MAP_MODELS.filter((m) => m.enabled);
  if (!narrowTo || narrowTo.length === 0) return enabled;
  const wanted = new Set(narrowTo);
  return enabled.filter((m) => wanted.has(m.id));
}

export function findWeatherMapModel(id: string): WeatherMapModel | undefined {
  return WEATHER_MAP_MODELS.find((m) => m.id === id);
}
