import { gunzipSync } from "node:zlib";

import { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";

import { getContainer } from "@/container";
import { authenticate } from "@/middlewares/authenticate.middleware";
import { rateLimit } from "@/middlewares/rate-limit.middleware";
import { GenericError } from "@/packages/error";
import { HTTPResponse } from "@/packages/route-utils";
import { successResponseSchema } from "@/packages/route-utils/openapi.schemas";
import type { HonoContext } from "@/types";

import { ActivityReason } from "../errors";
import {
  activityDetailResponseSchema,
  activityListResponseSchema,
  activityUidParamSchema,
  createActivityResponseSchema,
  createActivitySchema,
  createEquipmentSchema,
  equipmentListResponseSchema,
  equipmentResponseSchema,
  listActivitiesQuerySchema,
  patchActivitySchema,
} from "../schemas";

const jsonResponse = (schema: Parameters<typeof resolver>[0]) => ({
  200: {
    description: "OK",
    content: { "application/json": { schema: resolver(schema) } },
  },
});

// The GPS payload is large, so uploads arrive gzipped. zValidator("json") reads
// the raw (compressed) body, so the upload endpoint decompresses + validates
// itself. Everything else uses zValidator normally.
const readGzipBody = async <T>(
  c: {
    req: {
      arrayBuffer(): Promise<ArrayBuffer>;
      header(n: string): string | undefined;
    };
  },
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
): Promise<T> => {
  const raw = Buffer.from(await c.req.arrayBuffer());
  const body =
    c.req.header("Content-Encoding") === "gzip" ? gunzipSync(raw) : raw;
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf-8"));
  } catch {
    throw new GenericError("FORM_ERROR", {
      reason: ActivityReason.INVALID_UPLOAD,
      message: "Body is not valid JSON",
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success || parsed.data === undefined) {
    throw new GenericError("FORM_ERROR", {
      reason: ActivityReason.INVALID_UPLOAD,
      message: "Upload payload failed validation",
    });
  }
  return parsed.data;
};

// ── Activities (/v1/activities) ───────────────────────────────────────────────
export const activityRoute = new Hono<HonoContext>();
activityRoute.use("*", authenticate);

activityRoute.post(
  "/",
  describeRoute({
    operationId: "uploadActivity",
    tags: ["activity"],
    responses: jsonResponse(
      successResponseSchema(createActivityResponseSchema),
    ),
  }),
  rateLimit({ windowMs: 60_000, max: 30, keyPrefix: "activity-upload" }),
  async (c) => {
    const input = await readGzipBody(c, createActivitySchema);
    const result = await getContainer().activityService.create(
      c.var.user,
      input,
    );
    return c.json(HTTPResponse.success(result));
  },
);

activityRoute.get(
  "/",
  describeRoute({
    operationId: "listActivities",
    tags: ["activity"],
    responses: jsonResponse(successResponseSchema(activityListResponseSchema)),
  }),
  zValidator("query", listActivitiesQuerySchema),
  async (c) => {
    const result = await getContainer().activityService.list(
      c.var.user,
      c.req.valid("query"),
    );
    return c.json(HTTPResponse.success(result));
  },
);

activityRoute.get(
  "/:uid",
  describeRoute({
    operationId: "getActivity",
    tags: ["activity"],
    responses: jsonResponse(
      successResponseSchema(activityDetailResponseSchema),
    ),
  }),
  zValidator("param", activityUidParamSchema),
  async (c) => {
    const result = await getContainer().activityService.detail(
      c.var.user,
      c.req.valid("param").uid,
    );
    return c.json(HTTPResponse.success(result));
  },
);

activityRoute.patch(
  "/:uid",
  describeRoute({
    operationId: "updateActivity",
    tags: ["activity"],
    responses: { 204: { description: "Updated" } },
  }),
  zValidator("param", activityUidParamSchema),
  zValidator("json", patchActivitySchema),
  async (c) => {
    await getContainer().activityService.patchContext(
      c.var.user,
      c.req.valid("param").uid,
      c.req.valid("json"),
    );
    return c.body(null, 204);
  },
);

activityRoute.delete(
  "/:uid",
  describeRoute({
    operationId: "deleteActivity",
    tags: ["activity"],
    responses: { 204: { description: "Deleted" } },
  }),
  zValidator("param", activityUidParamSchema),
  async (c) => {
    await getContainer().activityService.remove(
      c.var.user,
      c.req.valid("param").uid,
    );
    return c.body(null, 204);
  },
);

// ── Equipment (/v1/equipment) ─────────────────────────────────────────────────
export const equipmentRoute = new Hono<HonoContext>();
equipmentRoute.use("*", authenticate);

equipmentRoute.get(
  "/",
  describeRoute({
    operationId: "listEquipment",
    tags: ["equipment"],
    responses: jsonResponse(successResponseSchema(equipmentListResponseSchema)),
  }),
  async (c) => {
    const result = await getContainer().equipmentService.list(c.var.user);
    return c.json(HTTPResponse.success(result));
  },
);

equipmentRoute.post(
  "/",
  describeRoute({
    operationId: "createEquipment",
    tags: ["equipment"],
    responses: jsonResponse(successResponseSchema(equipmentResponseSchema)),
  }),
  zValidator("json", createEquipmentSchema),
  async (c) => {
    const result = await getContainer().equipmentService.create(
      c.var.user,
      c.req.valid("json"),
    );
    return c.json(HTTPResponse.success(result));
  },
);
