import { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";

import { getContainer } from "@/container";
import { authenticate } from "@/middlewares/authenticate.middleware";
import { HTTPResponse } from "@/packages/route-utils";
import { successResponseSchema } from "@/packages/route-utils/openapi.schemas";
import type { HonoContext } from "@/types";

import {
  profileResponseSchema,
  sportParamSchema,
  sportProfileListResponseSchema,
  sportProfileResponseSchema,
  updateProfileSchema,
  upsertSportProfileSchema,
} from "../schemas";

// All routes are user-scoped (anonymous or Clerk) — mounted under /v1/me.
export const userRoute = new Hono<HonoContext>();

userRoute.use("*", authenticate);

userRoute.get(
  "/profile",
  describeRoute({
    operationId: "getMyProfile",
    tags: ["user"],
    responses: {
      200: {
        description: "The user's profile",
        content: {
          "application/json": {
            schema: resolver(successResponseSchema(profileResponseSchema)),
          },
        },
      },
    },
  }),
  async (c) => {
    const profile = await getContainer().userProfileService.getProfile(
      c.var.user,
    );
    return c.json(HTTPResponse.success(profile));
  },
);

userRoute.patch(
  "/profile",
  describeRoute({
    operationId: "updateMyProfile",
    tags: ["user"],
    responses: {
      200: {
        description: "The updated profile",
        content: {
          "application/json": {
            schema: resolver(successResponseSchema(profileResponseSchema)),
          },
        },
      },
    },
  }),
  zValidator("json", updateProfileSchema),
  async (c) => {
    const profile = await getContainer().userProfileService.updateProfile(
      c.var.user,
      c.req.valid("json"),
    );
    return c.json(HTTPResponse.success(profile));
  },
);

userRoute.get(
  "/sport-profiles",
  describeRoute({
    operationId: "listMySportProfiles",
    tags: ["user"],
    responses: {
      200: {
        description: "The user's per-sport profile overrides",
        content: {
          "application/json": {
            schema: resolver(
              successResponseSchema(sportProfileListResponseSchema),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const sportProfiles =
      await getContainer().userProfileService.getSportProfiles(c.var.user);
    return c.json(HTTPResponse.success({ sportProfiles }));
  },
);

userRoute.put(
  "/sport-profiles/:sport",
  describeRoute({
    operationId: "upsertMySportProfile",
    tags: ["user"],
    responses: {
      200: {
        description: "The upserted per-sport profile",
        content: {
          "application/json": {
            schema: resolver(successResponseSchema(sportProfileResponseSchema)),
          },
        },
      },
    },
  }),
  zValidator("param", sportParamSchema),
  zValidator("json", upsertSportProfileSchema),
  async (c) => {
    const { sport } = c.req.valid("param");
    const sportProfile =
      await getContainer().userProfileService.upsertSportProfile(
        c.var.user,
        sport,
        c.req.valid("json"),
      );
    return c.json(HTTPResponse.success(sportProfile));
  },
);
