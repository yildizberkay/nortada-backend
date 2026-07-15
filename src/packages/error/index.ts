import { HTTPException } from "hono/http-exception";

export type ErrorCode =
  | "INTERNAL_ERROR"
  | "FORM_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "EXTERNAL_SERVICE_ERROR"
  | "ALREADY_EXISTS"
  | "CONFLICT"
  | "RATE_LIMIT_EXCEEDED";

// Nortada delta (docs/architecture.md §2): ALREADY_EXISTS → 409, not brandscale's
// 422. `UNAUTHENTICATED` (401) / `FORBIDDEN` (403) — never `UNAUTHORIZED`.
const statusCodeMap: Record<ErrorCode, number> = {
  INTERNAL_ERROR: 500,
  FORM_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  EXTERNAL_SERVICE_ERROR: 500,
  ALREADY_EXISTS: 409,
  CONFLICT: 409,
  RATE_LIMIT_EXCEEDED: 429,
};

type ErrorOptions = {
  reason?: string; // machine-readable domain-specific code sent to client
  message?: string; // human-readable description sent to client
  data?: Record<string, string | number | object>; // debug data (logged only)
};

/**
 * Domain error carrying an HTTP status + machine-readable `reason`. Construction
 * is PURE (no logging side effects) — the error-handler middleware is the single
 * place that decides what gets logged/reported, so the two policies can't drift.
 */
export class GenericError extends HTTPException {
  errorCode: ErrorCode;
  statusCode: number;
  options?: ErrorOptions;

  constructor(errorCode: ErrorCode, options?: ErrorOptions) {
    const statusCode = statusCodeMap[errorCode];
    const message = options?.message ?? errorCode;

    super(statusCode as never, { message });

    this.errorCode = errorCode;
    this.statusCode = statusCode;
    this.options = options;
  }
}
