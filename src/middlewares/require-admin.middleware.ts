import type { Context, Next } from "hono";

import { GenericError } from "@/packages/error";
import type { HonoContext } from "@/types";

/**
 * Gate for admin-only routes. Must run AFTER `authenticate` (which sets
 * `c.var.user`). Fails closed — a missing user or non-admin is FORBIDDEN.
 */
export const requireAdmin = async (c: Context<HonoContext>, next: Next) => {
  if (!c.var.user?.isAdmin) {
    throw new GenericError("FORBIDDEN", {
      message: "Admin access is required",
    });
  }
  return next();
};
