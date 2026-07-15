import { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";

import { getContainer } from "@/container";
import { authenticate } from "@/middlewares/authenticate.middleware";
import { HTTPResponse } from "@/packages/route-utils";
import { successResponseSchema } from "@/packages/route-utils/openapi.schemas";
import type { HonoContext } from "@/types";

import {
  weatherMapCatalogResponseSchema,
  weatherMapFrameParamSchema,
  weatherMapManifestResponseSchema,
  weatherMapQuerySchema,
} from "../schemas";

// Weather-map textures for the map (RFC-0011) — mounted under /v1/weather-map.
export const weatherMapRoute = new Hono<HonoContext>();
weatherMapRoute.use("*", authenticate);

weatherMapRoute.get(
  "/models",
  describeRoute({
    operationId: "getWeatherMapCatalog",
    tags: ["weather-map"],
    responses: {
      200: {
        description: "Weather models and layers with map textures available",
        content: {
          "application/json": {
            schema: resolver(
              successResponseSchema(weatherMapCatalogResponseSchema),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const catalog = await getContainer().weatherMapService.getCatalog();
    return c.json(HTTPResponse.success(catalog));
  },
);

weatherMapRoute.get(
  "/",
  describeRoute({
    operationId: "getWeatherMapManifest",
    tags: ["weather-map"],
    responses: {
      200: {
        description:
          "Available textures for one (model, layer), ordered by valid time; each URL is stable per hour and repainted in place by newer runs",
        content: {
          "application/json": {
            schema: resolver(
              successResponseSchema(weatherMapManifestResponseSchema),
            ),
          },
        },
      },
    },
  }),
  zValidator("query", weatherMapQuerySchema),
  async (c) => {
    const { model, layer } = c.req.valid("query");
    const manifest = await getContainer().weatherMapService.getManifest(
      model,
      layer,
    );
    return c.json(HTTPResponse.success(manifest));
  },
);

// Fallback proxy for environments without OBJECT_STORAGE_PUBLIC_BASE_URL —
// streams the PNG out of object storage. The strict file pattern + the DB
// existence check keep this from reading arbitrary keys in the shared bucket.
weatherMapRoute.get(
  "/frames/:model/:layer/:file",
  describeRoute({
    operationId: "getWeatherMapFrame",
    tags: ["weather-map"],
    responses: {
      200: {
        description:
          "Weather-map texture PNG (wind: R=u, G=v, B=gust; scalar layers: R=value)",
        content: { "image/png": {} },
      },
    },
  }),
  zValidator("param", weatherMapFrameParamSchema),
  async (c) => {
    const { model, layer, file } = c.req.valid("param");
    const png = await getContainer().weatherMapService.getFrameObject(
      model,
      layer,
      file,
    );
    c.header("Content-Type", "image/png");
    // Frames repaint in place when a model publishes (at most hourly) — a
    // short shared cache keeps repeat viewers off R2 without serving a stale
    // run for long.
    c.header("Cache-Control", "public, max-age=300");
    return c.body(new Uint8Array(png));
  },
);
