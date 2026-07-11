import type { Context, Next } from "hono";

import { GenericError } from "@/packages/error";

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key per window. */
  max: number;
  /** Namespace so different routes don't share buckets. */
  keyPrefix?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

// Client IP behind a proxy (Railway sets x-forwarded-for). Falls back to a
// shared "unknown" bucket only when no proxy header is present (local/dev).
const clientIp = (c: Context): string => {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return c.req.header("x-real-ip") ?? "unknown";
};

/**
 * Fixed-window rate limiter. In-memory + single-instance only (see
 * docs/otonom-kararlar.md) — a coarse abuse valve for the unauthenticated
 * bootstrap endpoints, to be swapped for a Postgres/Redis store when the API
 * scales to multiple instances. Each call owns its own bucket store.
 */
export const rateLimit = (options: RateLimitOptions) => {
  const { windowMs, max, keyPrefix = "rl" } = options;
  const store = new Map<string, Bucket>();
  let lastSweep = 0;

  return async (c: Context, next: Next) => {
    const now = Date.now();

    // Opportunistically drop expired buckets so memory stays bounded.
    if (now - lastSweep > windowMs) {
      for (const [k, b] of store) {
        if (b.resetAt <= now) {
          store.delete(k);
        }
      }
      lastSweep = now;
    }

    const key = `${keyPrefix}:${clientIp(c)}`;
    const bucket = store.get(key);

    if (!bucket || bucket.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      throw new GenericError("RATE_LIMIT_EXCEEDED", {
        message: "Too many requests, please try again later",
      });
    }

    bucket.count += 1;
    return next();
  };
};
