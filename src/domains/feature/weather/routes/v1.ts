import { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";

import { getContainer } from "@/container";
import { authenticate } from "@/middlewares/authenticate.middleware";
import { HTTPResponse } from "@/packages/route-utils";
import { successResponseSchema } from "@/packages/route-utils/openapi.schemas";
import type { HonoContext } from "@/types";

import {
  conditionsResponseSchema,
  forecastResponseSchema,
  spotUidParamSchema,
  weatherQuerySchema,
} from "../schemas";

// Weather for a spot — mounted under /v1/spots (alongside the spot detail
// route; distinct sub-paths so both routers coexist).
export const weatherRoute = new Hono<HonoContext>();
weatherRoute.use("*", authenticate);

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
