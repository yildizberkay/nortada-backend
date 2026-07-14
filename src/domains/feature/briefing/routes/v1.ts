import { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";

import { getContainer } from "@/container";
import { authenticate } from "@/middlewares/authenticate.middleware";
import { HTTPResponse } from "@/packages/route-utils";
import { successResponseSchema } from "@/packages/route-utils/openapi.schemas";
import type { HonoContext } from "@/types";

import { briefingQuerySchema, briefingResponseSchema } from "../schemas";

// The Today briefing — mounted under /v1/me/briefing (the favorites pattern:
// one router per sub-resource under /v1/me).
export const briefingRoute = new Hono<HonoContext>();
briefingRoute.use("*", authenticate);

briefingRoute.get(
  "/",
  describeRoute({
    operationId: "getTodayBriefing",
    tags: ["briefing"],
    responses: {
      200: {
        description:
          "Ranked top pick + alternatives + briefing state + decision reasons; an empty candidate set is state=noSpots, never an error",
        content: {
          "application/json": {
            schema: resolver(successResponseSchema(briefingResponseSchema)),
          },
        },
      },
    },
  }),
  zValidator("query", briefingQuerySchema),
  async (c) => {
    const briefing = await getContainer().briefingService.getBriefing(
      c.var.user,
      c.req.valid("query"),
    );
    return c.json(HTTPResponse.success(briefing));
  },
);
