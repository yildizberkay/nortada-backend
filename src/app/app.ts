import { swaggerUI } from "@hono/swagger-ui";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { contextStorage } from "hono/context-storage";
import { cors } from "hono/cors";
import { openAPIRouteHandler } from "hono-openapi";

import { globalConfig } from "@/app/global-config";
import { getDBClient } from "@/db/db.manager";
import { registerRoutes } from "@/domains";
import { errorHandler } from "@/middlewares/error-handler.middleware";
import type { HonoContext } from "@/types";

const app = new Hono<HonoContext>();

app.use(contextStorage());
app.use(compress());

app.use(
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Accept-Language"],
  }),
);

// Liveness — is the process up? No dependencies, so a DB blip never triggers a
// pointless restart.
app.get("/health", (c) => c.body(null, 200));

// Readiness — can we actually serve traffic (DB reachable)?
app.get("/health/ready", async (c) => {
  const db = getDBClient();
  await db.execute(sql`SELECT 1`);
  return c.body(null, 200);
});

registerRoutes(app);

if (globalConfig.isDev) {
  app.get(
    "/openapi.json",
    openAPIRouteHandler(app as never, {
      documentation: {
        info: {
          title: "Splash API",
          version: "0.1.0",
          description: "Splash backend API documentation",
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    }),
  );

  app.get(
    "/docs",
    swaggerUI({
      url: "/openapi.json",
      title: "Splash API Docs",
    }),
  );
}

app.onError(errorHandler);

export { app };
