import { z } from "zod";

// ── Requests ──────────────────────────────────────────────────────────────────

export const weatherMapQuerySchema = z.object({
  // A registered `data_spatial` model id + a registered layer id (see
  // GET /v1/weather-map/models); registry membership is enforced in the
  // service, not the schema, so errors carry the domain reason.
  model: z.string().min(1),
  layer: z.string().min(1),
});
export type WeatherMapQuery = z.infer<typeof weatherMapQuerySchema>;

// The proxy route's file segment is exactly what the manifest emitted:
// a compact valid time + .png. Strict shape (plus the DB existence check)
// keeps the route from reading arbitrary keys out of the shared bucket.
export const weatherMapFrameParamSchema = z.object({
  model: z.string().min(1),
  layer: z.string().min(1),
  file: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{4}Z\.png$/),
});
export type WeatherMapFrameParam = z.infer<typeof weatherMapFrameParamSchema>;

// ── Responses ─────────────────────────────────────────────────────────────────

export const weatherMapCatalogResponseSchema = z
  .object({
    models: z.array(
      z.object({
        model: z.string(),
        label: z.string(),
        provider: z.string(),
        resolutionKm: z.number(),
        // Layers this model currently serves frames for — drive the map's
        // layer picker from this (empty = nothing selectable right now).
        layers: z.array(z.string()),
        // Geographic coverage of the model's grid (regional models cover a
        // slice of the world — restrict/inform selection by viewport).
        coverage: z
          .object({
            west: z.number(),
            south: z.number(),
            east: z.number(),
            north: z.number(),
          })
          .nullable(),
        // Newest run among the fresh frames.
        run: z.iso.datetime().nullable(),
        // Latest forecast hour currently rendered (the scrubber's end).
        validThrough: z.iso.datetime().nullable(),
      }),
    ),
    layers: z.array(
      z.object({
        layer: z.string(),
        label: z.string(),
        // Unit of the decoded values (m/s, °C, mm, …).
        unit: z.string(),
      }),
    ),
  })
  .describe(
    "Weather models and layers with map textures available; per-model layer availability and coverage are derived from the rendered frames",
  )
  .meta({ ref: "WeatherMapCatalogResponse" });

const weatherMapFrameSchema = z.object({
  // The hour this texture describes (UTC). Stable per hour: newer model runs
  // repaint the same frame/URL in place.
  validTime: z.iso.datetime(),
  // Reference time of the model run that last painted this frame.
  runTime: z.iso.datetime(),
  url: z.string(),
  width: z.number(),
  height: z.number(),
  bbox: z.object({
    west: z.number(),
    south: z.number(),
    east: z.number(),
    north: z.number(),
  }),
  // Layer-shaped channel-byte → value decode payload. Wind: {uMin, uMax,
  // vMin, vMax, gustMin, gustMax, hasRealGust} for R=u, G=v, B=gust. Scalar
  // layers: {min, max} for R=value.
  scales: z.record(z.string(), z.union([z.number(), z.boolean()])),
});

export const weatherMapManifestResponseSchema = z
  .object({
    model: z.string(),
    layer: z.string(),
    unit: z.string(),
    // Newest run among the frames; null while nothing is rendered yet.
    run: z.iso.datetime().nullable(),
    frames: z.array(weatherMapFrameSchema),
  })
  .describe(
    "Available textures for one (model, layer), ordered by valid time (current hour first)",
  )
  .meta({ ref: "WeatherMapManifestResponse" });
