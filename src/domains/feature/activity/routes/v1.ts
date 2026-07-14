import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";
import { z } from "zod";

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

const gunzipAsync = promisify(gunzip);

// Hard caps on the upload body. `bodyLimit` aborts the request before the whole
// body is buffered; `MAX_DECOMPRESSED_BYTES` (passed to gunzip's maxOutputLength)
// bounds the inflated size so a small gzip payload can't decompression-bomb the
// process. A 200k-sample track is ~16 MB of JSON / ~2–3 MB gzipped.
const MAX_REQUEST_BYTES = 24 * 1024 * 1024; // 24 MiB on the wire
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024; // 64 MiB inflated

const invalidUpload = (message: string) =>
  new GenericError("FORM_ERROR", {
    reason: ActivityReason.INVALID_UPLOAD,
    message,
  });

// The GPS payload is large, so uploads arrive gzipped. zValidator("json") reads
// the raw (compressed) body, so the upload endpoint decompresses + validates
// itself. Decompression is async (never blocks the event loop) and capped
// (never OOMs). Everything else uses zValidator normally.
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

  let body: Buffer;
  try {
    body =
      c.req.header("Content-Encoding") === "gzip"
        ? await gunzipAsync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
        : raw;
  } catch {
    // Malformed gzip, or a decompression bomb exceeding maxOutputLength — a bad
    // client request, not a server error (would otherwise surface as a 500).
    throw invalidUpload("Upload body could not be decompressed");
  }
  if (body.byteLength > MAX_DECOMPRESSED_BYTES) {
    throw invalidUpload("Upload body too large");
  }

  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf-8"));
  } catch {
    throw invalidUpload("Body is not valid JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success || parsed.data === undefined) {
    throw invalidUpload("Upload payload failed validation");
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
    // Documented explicitly — the body is validated by readGzipBody (not
    // zValidator), so without this the OpenAPI spec (and every generated
    // client) had NO request body for the upload endpoint.
    requestBody: {
      required: true,
      description:
        "Activity payload; large GPS tracks may be gzip-compressed (Content-Encoding: gzip)",
      content: {
        "application/json": {
          // resolver() instances are only resolved inside `responses`;
          // requestBody must carry a plain JSON schema, so convert eagerly
          // (input shape: optionals/defaults as the CLIENT sends them).
          // draft-2020-12 = OpenAPI 3.1's native dialect (the served spec is
          // 3.1) — the 3.0 target's `nullable:` keyword is a no-op there.
          schema: z.toJSONSchema(createActivitySchema, {
            io: "input",
            target: "draft-2020-12",
          }) as never,
        },
      },
    },
    responses: jsonResponse(
      successResponseSchema(createActivityResponseSchema),
    ),
  }),
  rateLimit({ windowMs: 60_000, max: 30, keyPrefix: "activity-upload" }),
  bodyLimit({
    maxSize: MAX_REQUEST_BYTES,
    onError: (c) =>
      c.json(
        HTTPResponse.error({
          error: "FORM_ERROR",
          reason: ActivityReason.INVALID_UPLOAD,
          message: "Upload body too large",
          statusCode: 413,
        }),
        413,
      ),
  }),
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
