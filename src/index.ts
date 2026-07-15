import { networkInterfaces } from "node:os";

import { serve } from "@hono/node-server";

import { globalConfig } from "./app/global-config";
import { initializeApp } from "./app/initialize-services";
import { getDBManager } from "./db/db.manager";
import { createLogger } from "./packages/logger";

const logger = createLogger("server");

// First non-internal IPv4 address — the URL a phone/simulator on the same
// network can reach the dev server at.
const lanAddress = (): string | undefined => {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return undefined;
};

const main = async () => {
  await initializeApp();

  // Imported dynamically AFTER initializeApp so config/DB are ready before any
  // module-load-time container wiring runs.
  const { app } = await import("./app/app");

  const port = Number(process.env.PORT || 3000);

  serve({ fetch: app.fetch, port }, () => {
    logger.info(`Local:   http://localhost:${port}`);
    const lan = lanAddress();
    if (lan) {
      logger.info(`Network: http://${lan}:${port}`);
    }
    if (globalConfig.isDev) {
      logger.info(`Swagger: http://localhost:${port}/docs`);
      logger.info(`OpenAPI: http://localhost:${port}/openapi.json`);
    }
  });
};

const shutdown = async () => {
  logger.info("Shutting down...");
  await getDBManager().reset();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Failed to start server:", err);
  logger.error("Failed to start server", { error: String(err) });
  process.exit(1);
});
