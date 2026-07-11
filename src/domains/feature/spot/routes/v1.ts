import { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";

import { getContainer } from "@/container";
import { authenticate } from "@/middlewares/authenticate.middleware";
import { rateLimit } from "@/middlewares/rate-limit.middleware";
import { requireAdmin } from "@/middlewares/require-admin.middleware";
import { HTTPResponse } from "@/packages/route-utils";
import { successResponseSchema } from "@/packages/route-utils/openapi.schemas";
import type { HonoContext } from "@/types";

import {
  adminSpotQuerySchema,
  favoriteSpotSchema,
  favoriteUidParamSchema,
  ingestResponseSchema,
  ingestSpotsSchema,
  moderateSpotSchema,
  nearbyQuerySchema,
  nearbySpotResponseSchema,
  searchQuerySchema,
  spotListResponseSchema,
  spotResponseSchema,
  spotUidParamSchema,
  suggestSpotSchema,
} from "../schemas";

const jsonResponse = (schema: Parameters<typeof resolver>[0]) => ({
  200: {
    description: "OK",
    content: { "application/json": { schema: resolver(schema) } },
  },
});

// ── Public spot discovery + suggestion (/v1/spots) ────────────────────────────
export const spotRoute = new Hono<HonoContext>();
spotRoute.use("*", authenticate);

spotRoute.get(
  "/nearby",
  describeRoute({
    operationId: "nearbySpots",
    tags: ["spot"],
    responses: jsonResponse(successResponseSchema(nearbySpotResponseSchema)),
  }),
  zValidator("query", nearbyQuerySchema),
  async (c) => {
    const spots = await getContainer().spotService.nearby(c.req.valid("query"));
    return c.json(HTTPResponse.success({ spots }));
  },
);

spotRoute.get(
  "/search",
  describeRoute({
    operationId: "searchSpots",
    tags: ["spot"],
    responses: jsonResponse(successResponseSchema(spotListResponseSchema)),
  }),
  zValidator("query", searchQuerySchema),
  async (c) => {
    const spots = await getContainer().spotService.search(c.req.valid("query"));
    return c.json(HTTPResponse.success({ spots }));
  },
);

spotRoute.post(
  "/suggest",
  describeRoute({
    operationId: "suggestSpot",
    tags: ["spot"],
    responses: jsonResponse(successResponseSchema(spotResponseSchema)),
  }),
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "spot-suggest" }),
  zValidator("json", suggestSpotSchema),
  async (c) => {
    const spot = await getContainer().spotService.suggest(
      c.var.user,
      c.req.valid("json"),
    );
    return c.json(HTTPResponse.success(spot));
  },
);

spotRoute.get(
  "/:uid",
  describeRoute({
    operationId: "getSpot",
    tags: ["spot"],
    responses: jsonResponse(successResponseSchema(spotResponseSchema)),
  }),
  zValidator("param", spotUidParamSchema),
  async (c) => {
    const spot = await getContainer().spotService.detail(
      c.req.valid("param").uid,
    );
    return c.json(HTTPResponse.success(spot));
  },
);

// ── Admin moderation (/v1/admin/spots) ────────────────────────────────────────
export const adminSpotRoute = new Hono<HonoContext>();
adminSpotRoute.use("*", authenticate, requireAdmin);

adminSpotRoute.get(
  "/",
  describeRoute({
    operationId: "listSpotsForModeration",
    tags: ["admin"],
    responses: jsonResponse(successResponseSchema(spotListResponseSchema)),
  }),
  zValidator("query", adminSpotQuerySchema),
  async (c) => {
    const { status, limit } = c.req.valid("query");
    const spots = await getContainer().spotService.listByStatus(status, limit);
    return c.json(HTTPResponse.success({ spots }));
  },
);

adminSpotRoute.post(
  "/ingest",
  describeRoute({
    operationId: "ingestSpots",
    tags: ["admin"],
    responses: jsonResponse(successResponseSchema(ingestResponseSchema)),
  }),
  zValidator("json", ingestSpotsSchema),
  async (c) => {
    const { isoCountryCode } = c.req.valid("json");
    const result =
      await getContainer().spotService.requestOsmIngest(isoCountryCode);
    return c.json(HTTPResponse.success(result));
  },
);

adminSpotRoute.patch(
  "/:uid",
  describeRoute({
    operationId: "moderateSpot",
    tags: ["admin"],
    responses: jsonResponse(successResponseSchema(spotResponseSchema)),
  }),
  zValidator("param", spotUidParamSchema),
  zValidator("json", moderateSpotSchema),
  async (c) => {
    const spot = await getContainer().spotService.moderate(
      c.req.valid("param").uid,
      c.req.valid("json"),
    );
    return c.json(HTTPResponse.success(spot));
  },
);

// ── Favorites (/v1/me/favorites) ──────────────────────────────────────────────
export const favoriteRoute = new Hono<HonoContext>();
favoriteRoute.use("*", authenticate);

favoriteRoute.get(
  "/",
  describeRoute({
    operationId: "listFavorites",
    tags: ["favorite"],
    responses: jsonResponse(successResponseSchema(spotListResponseSchema)),
  }),
  async (c) => {
    const spots = await getContainer().favoriteService.list(c.var.user);
    return c.json(HTTPResponse.success({ spots }));
  },
);

favoriteRoute.post(
  "/",
  describeRoute({
    operationId: "addFavorite",
    tags: ["favorite"],
    responses: jsonResponse(successResponseSchema(spotResponseSchema)),
  }),
  zValidator("json", favoriteSpotSchema),
  async (c) => {
    const spot = await getContainer().favoriteService.add(
      c.var.user,
      c.req.valid("json").spotUid,
    );
    return c.json(HTTPResponse.success(spot));
  },
);

favoriteRoute.delete(
  "/:spotUid",
  describeRoute({
    operationId: "removeFavorite",
    tags: ["favorite"],
    responses: { 204: { description: "Removed" } },
  }),
  zValidator("param", favoriteUidParamSchema),
  async (c) => {
    await getContainer().favoriteService.remove(
      c.var.user,
      c.req.valid("param").spotUid,
    );
    return c.body(null, 204);
  },
);
