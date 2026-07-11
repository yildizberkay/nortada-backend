import type { Hono } from "hono";

import type { HonoContext } from "@/types";

/**
 * Central route registry. Each domain mounts under `/v1/<domain>` from
 * RFC-0002 onwards, e.g. `app.route("/v1/auth", authRoute)`.
 */
export const registerRoutes = (app: Hono<HonoContext>) => {
  void app;
};
