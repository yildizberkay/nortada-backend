import { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";

import { getContainer } from "@/container";
import { authenticate } from "@/middlewares/authenticate.middleware";
import { HTTPResponse } from "@/packages/route-utils";
import { successResponseSchema } from "@/packages/route-utils/openapi.schemas";
import type { HonoContext } from "@/types";

import {
  batchConditionsQuerySchema,
  batchConditionsResponseSchema,
  conditionsResponseSchema,
  forecastResponseSchema,
  spotUidParamSchema,
  virtualConditionsResponseSchema,
  virtualForecastResponseSchema,
  virtualSpotQuerySchema,
  weatherQuerySchema,
} from "../schemas";

// Weather for a spot — mounted under /v1/spots (alongside the spot detail
// route; distinct sub-paths so both routers coexist).
export const weatherRoute = new Hono<HonoContext>();
weatherRoute.use("*", authenticate);

// NOTE: the path is /conditions/batch (two static segments) — a bare
// /conditions would be swallowed by the spot router's GET /:uid, which is
// mounted first on the same base.
weatherRoute.get(
  "/conditions/batch",
  describeRoute({
    operationId: "batchSpotConditions",
    tags: ["weather"],
    responses: {
      200: {
        description:
          "Now-cast conditions for up to 50 spots in one round-trip (comma-separated uids; unresolvable spots are omitted)",
        content: {
          "application/json": {
            schema: resolver(
              successResponseSchema(batchConditionsResponseSchema),
            ),
          },
        },
      },
    },
  }),
  zValidator("query", batchConditionsQuerySchema),
  async (c) => {
    const { uids, sport } = c.req.valid("query");
    const result = await getContainer().weatherService.getConditionsBatch(
      uids,
      { sport },
    );
    return c.json(HTTPResponse.success(result));
  },
);

// RFC-0012 virtual spot: the same spot-grade payloads for a bare coordinate —
// no catalog row involved, nothing persisted by looking. Registered BEFORE
// the /:uid routes so the static "virtual" segment wins the match.
weatherRoute.get(
  "/virtual/conditions",
  describeRoute({
    operationId: "getVirtualSpotConditions",
    tags: ["weather"],
    responses: {
      200: {
        description:
          "Now-cast conditions + verdict for an arbitrary coordinate (virtual spot)",
        content: {
          "application/json": {
            schema: resolver(
              successResponseSchema(virtualConditionsResponseSchema),
            ),
          },
        },
      },
    },
  }),
  zValidator("query", virtualSpotQuerySchema),
  async (c) => {
    const conditions = await getContainer().weatherService.getConditionsAt(
      c.req.valid("query"),
    );
    return c.json(HTTPResponse.success(conditions));
  },
);

weatherRoute.get(
  "/virtual/forecast",
  describeRoute({
    operationId: "getVirtualSpotForecast",
    tags: ["weather"],
    responses: {
      200: {
        description:
          "Hourly + daily forecast strip for an arbitrary coordinate (virtual spot)",
        content: {
          "application/json": {
            schema: resolver(
              successResponseSchema(virtualForecastResponseSchema),
            ),
          },
        },
      },
    },
  }),
  zValidator("query", virtualSpotQuerySchema),
  async (c) => {
    const forecast = await getContainer().weatherService.getForecastAt(
      c.req.valid("query"),
    );
    return c.json(HTTPResponse.success(forecast));
  },
);

weatherRoute.get(
  "/:uid/conditions",
  describeRoute({
    operationId: "getSpotConditions",
    tags: ["weather"],
    responses: {
      200: {
        description: "Now-cast conditions + verdict",
        content: {
          "application/json": {
            schema: resolver(successResponseSchema(conditionsResponseSchema)),
          },
        },
      },
    },
  }),
  zValidator("param", spotUidParamSchema),
  zValidator("query", weatherQuerySchema),
  async (c) => {
    const conditions = await getContainer().weatherService.getConditions(
      c.req.valid("param").uid,
      c.req.valid("query"),
    );
    return c.json(HTTPResponse.success(conditions));
  },
);

weatherRoute.get(
  "/:uid/forecast",
  describeRoute({
    operationId: "getSpotForecast",
    tags: ["weather"],
    responses: {
      200: {
        description: "Hourly + daily forecast strip",
        content: {
          "application/json": {
            schema: resolver(successResponseSchema(forecastResponseSchema)),
          },
        },
      },
    },
  }),
  zValidator("param", spotUidParamSchema),
  zValidator("query", weatherQuerySchema),
  async (c) => {
    const forecast = await getContainer().weatherService.getForecast(
      c.req.valid("param").uid,
      c.req.valid("query"),
    );
    return c.json(HTTPResponse.success(forecast));
  },
);
