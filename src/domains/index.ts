import type { Hono } from "hono";

import { authRoute } from "@/domains/platform/auth/routes/v1";
import type { HonoContext } from "@/types";

/**
 * Central route registry. Each domain mounts under `/v1/<domain>`.
 */
export const registerRoutes = (app: Hono<HonoContext>) => {
  app.route("/v1/auth", authRoute);
};
