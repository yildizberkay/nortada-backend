import type { Context, Next } from "hono";

import { getContainer } from "@/container";
import { AuthReason } from "@/domains/platform/auth/errors";
import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";

const logger = createLogger("authenticate");

const extractBearerToken = (
  authorizationHeader: string | undefined,
): string => {
  if (!authorizationHeader) {
    throw new GenericError("UNAUTHENTICATED", {
      reason: AuthReason.MISSING_TOKEN,
      message: "Authorization header is missing",
    });
  }
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new GenericError("UNAUTHENTICATED", {
      reason: AuthReason.MISSING_TOKEN,
      message: "Authorization header must be 'Bearer <token>'",
    });
  }
  return token;
};

/**
 * Dual-source auth: verifies an anonymous JWT OR a Clerk session token and sets
 * `c.var.user`. Mount on any route that requires a user (anonymous or real).
 */
export const authenticate = async (c: Context, next: Next) => {
  try {
    const token = extractBearerToken(c.req.header("Authorization"));
    const user = await getContainer().authService.authenticateToken(token);
    c.set("user", user);
    return next();
  } catch (error: unknown) {
    if (error instanceof GenericError) {
      throw error;
    }
    logger.error("Unexpected auth failure", { error: String(error) });
    throw new GenericError("INTERNAL_ERROR");
  }
};
