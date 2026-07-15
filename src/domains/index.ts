import type { Hono } from "hono";

import {
  activityRoute,
  equipmentRoute,
} from "@/domains/feature/activity/routes/v1";
import { briefingRoute } from "@/domains/feature/briefing/routes/v1";
import {
  adminSpotRoute,
  favoriteRoute,
  spotRoute,
} from "@/domains/feature/spot/routes/v1";
import { weatherRoute } from "@/domains/feature/weather/routes/v1";
import { weatherMapRoute } from "@/domains/feature/weathermap/routes/v1";
import { authRoute } from "@/domains/platform/auth/routes/v1";
import { userRoute } from "@/domains/platform/user/routes/v1";
import type { HonoContext } from "@/types";

/**
 * Central route registry. Each domain mounts under `/v1/<domain>`.
 */
export const registerRoutes = (app: Hono<HonoContext>) => {
  app.route("/v1/auth", authRoute);
  app.route("/v1/me", userRoute);
  app.route("/v1/spots", spotRoute);
  // Weather sub-paths (/v1/spots/:uid/conditions|forecast) — coexists with spotRoute.
  app.route("/v1/spots", weatherRoute);
  app.route("/v1/admin/spots", adminSpotRoute);
  app.route("/v1/me/favorites", favoriteRoute);
  app.route("/v1/me/briefing", briefingRoute);
  app.route("/v1/activities", activityRoute);
  app.route("/v1/equipment", equipmentRoute);
  app.route("/v1/weather-map", weatherMapRoute);
};
