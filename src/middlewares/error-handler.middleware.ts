import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { HTTPResponseError } from "hono/types";

import { Tracking } from "@/app/tracking";
import { type ErrorCode, GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";
import { HTTPResponse } from "@/packages/route-utils";
import type { HonoContext } from "@/types";

const logger = createLogger("errorHandler");

// System-failure codes → reported as exceptions (should page ops; each
// occurrence is a bug or infra incident).
const REPORTABLE_ERROR_CODES: readonly ErrorCode[] = [
  "INTERNAL_ERROR",
  "EXTERNAL_SERVICE_ERROR",
];

// Expected-within-normal-operation anomalies → tracked as events for
// volume/funnel dashboards without polluting error-rate alerts.
const MONITORED_ERROR_CODES: readonly ErrorCode[] = ["RATE_LIMIT_EXCEEDED"];

export const errorHandler = (
  error: Error | HTTPResponseError | GenericError,
  context: Context<HonoContext>,
) => {
  const actor = { userUid: context.var.user?.uid };
  const extra = { path: context.req.path };

  // The middleware knows the request context, so the report-vs-silent decision
  // lives here (not inside Tracking).
  if (error instanceof GenericError) {
    if (REPORTABLE_ERROR_CODES.includes(error.errorCode)) {
      Tracking.captureException(error, actor, extra);
    } else if (MONITORED_ERROR_CODES.includes(error.errorCode)) {
      Tracking.trackErrorEvent(error, actor, extra);
    }
    // Other GenericErrors (FORM_ERROR, NOT_FOUND, UNAUTHENTICATED, …) are
    // expected user-facing outcomes — no tracking.

    context.status(error.statusCode as never);
    return context.json(
      HTTPResponse.error({
        error: error.errorCode,
        reason: error.options?.reason,
        message: error.message,
        statusCode: error.statusCode,
      }),
    );
  }

  // A plain Hono HTTPException (thrown by the framework or a library) carries
  // its own status — honor it and treat it as an expected client-facing outcome
  // (no exception report), rather than collapsing a 4xx into a false 500.
  if (error instanceof HTTPException) {
    context.status(error.status);
    return context.json(
      HTTPResponse.error({
        error: "HTTP_EXCEPTION",
        message: error.message,
        statusCode: error.status,
      }),
    );
  }

  // Unhandled non-HTTP error: always report — genuine surprises that bypassed
  // domain error wrapping.
  Tracking.captureException(error, actor, extra);

  logger.error("Unhandled error", {
    error: error.message,
    trace: error.stack,
  });
  context.status(500);
  return context.json(
    HTTPResponse.error({
      error: "INTERNAL_ERROR",
      message: "Internal Server Error",
      statusCode: 500,
    }),
  );
};
