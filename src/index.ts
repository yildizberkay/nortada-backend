import { serve } from "@hono/node-server";

import { initializeApp } from "./app/initialize-services";
import { getDBManager } from "./db/db.manager";
import { createLogger } from "./packages/logger";

const logger = createLogger("server");

const main = async () => {
  await initializeApp();

  // Imported dynamically AFTER initializeApp so config/DB are ready before any
  // module-load-time container wiring runs.
  const { app } = await import("./app/app");

  const port = Number(process.env.PORT || 3000);

  serve({ fetch: app.fetch, port }, () => {
    logger.info(`Server listening on port ${port}`);
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
