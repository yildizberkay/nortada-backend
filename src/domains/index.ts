import type { Hono } from "hono";

import { authRoute } from "@/domains/platform/auth/routes/v1";
import { userRoute } from "@/domains/platform/user/routes/v1";
import type { HonoContext } from "@/types";

/**
 * Central route registry. Each domain mounts under `/v1/<domain>`.
 */
export const registerRoutes = (app: Hono<HonoContext>) => {
  app.route("/v1/auth", authRoute);
  app.route("/v1/me", userRoute);
};
