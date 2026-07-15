import type { Context, Next } from "hono";

import { createLogger } from "@/packages/logger";
import type { HonoContext } from "@/types";

const logger = createLogger("http");

// Infra probes hit these every few seconds — logging them is pure noise.
const SKIP_PATHS = new Set(["/health", "/health/ready"]);

/**
 * Verbose per-request log line (method, path, status, duration, caller) at
 * `debug` level — on locally by default, off in prod unless a deploy sets
 * `LOG_LEVEL=debug` (see packages/logger). Thrown errors are already turned
 * into responses by Hono's compose before `next()` resolves, so failed
 * requests get logged with their real status too.
 */
export const requestLogger = () => {
  return async (c: Context<HonoContext<true>>, next: Next) => {
    if (SKIP_PATHS.has(c.req.path)) {
      return next();
    }

    const start = performance.now();
    await next();

    const query = c.req.query();
    logger.debug(`${c.req.method} ${c.req.path} → ${c.res.status}`, {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
      ...(Object.keys(query).length > 0 ? { query } : {}),
      userUid: c.var.user?.uid,
    });
  };
};
