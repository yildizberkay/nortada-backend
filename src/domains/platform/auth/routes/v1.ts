import { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";

import { getContainer } from "@/container";
import type { User } from "@/db";
import { authenticate } from "@/middlewares/authenticate.middleware";
import { rateLimit } from "@/middlewares/rate-limit.middleware";
import { HTTPResponse } from "@/packages/route-utils";
import { successResponseSchema } from "@/packages/route-utils/openapi.schemas";
import type { HonoContext } from "@/types";

import {
  anonymousAuthResponseSchema,
  anonymousAuthSchema,
  linkSchema,
  userResponseSchema,
} from "../schemas";

const toUserResponse = (user: User) => ({
  uid: user.uid,
  isAnonymous: user.isAnonymous,
  email: user.email,
  displayName: user.displayName,
});

// Abuse valve on the unauthenticated bootstrap + link endpoints: without it,
// /anonymous is unbounded INSERT + token-mint per unknown deviceId (RFC-0002 §9).
const bootstrapRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyPrefix: "auth-bootstrap",
});

export const authRoute = new Hono<HonoContext>();

// Bootstrap an anonymous identity for a device. No auth (this is where the
// device gets its first token).
authRoute.post(
  "/anonymous",
  describeRoute({
    operationId: "createAnonymousSession",
    tags: ["auth"],
    responses: {
      200: {
        description: "Anonymous token + user",
        content: {
          "application/json": {
            schema: resolver(
              successResponseSchema(anonymousAuthResponseSchema),
            ),
          },
        },
      },
    },
  }),
  bootstrapRateLimit,
  zValidator("json", anonymousAuthSchema),
  async (c) => {
    const { deviceId } = c.req.valid("json");
    const { token, user } =
      await getContainer().authService.issueAnonymous(deviceId);
    return c.json(HTTPResponse.success({ token, user: toUserResponse(user) }));
  },
);

// Link the current anonymous identity to a Clerk account.
authRoute.post(
  "/link",
  describeRoute({
    operationId: "linkAnonymousToClerk",
    tags: ["auth"],
    responses: {
      200: {
        description: "The linked user",
        content: {
          "application/json": {
            schema: resolver(successResponseSchema(userResponseSchema)),
          },
        },
      },
    },
  }),
  bootstrapRateLimit,
  authenticate,
  zValidator("json", linkSchema),
  async (c) => {
    const user = c.var.user;
    const { clerkToken } = c.req.valid("json");
    const linked = await getContainer().authService.linkAnonymousToClerk(
      user,
      clerkToken,
    );
    return c.json(HTTPResponse.success(toUserResponse(linked)));
  },
);

// Current user (anonymous or Clerk).
authRoute.get(
  "/me",
  describeRoute({
    operationId: "getCurrentUser",
    tags: ["auth"],
    responses: {
      200: {
        description: "The current user",
        content: {
          "application/json": {
            schema: resolver(successResponseSchema(userResponseSchema)),
          },
        },
      },
    },
  }),
  authenticate,
  async (c) => {
    const user = await getContainer().authService.getCurrentUser(c.var.user);
    return c.json(HTTPResponse.success(toUserResponse(user)));
  },
);
