import { defineConfig } from "@trigger.dev/sdk";

/**
 * Local-dev Trigger config that indexes ONLY the activity tasks
 * (`npm run trigger:dev` → this file). The scheduled weather/auth crons
 * already run in prod; a full local index would register their declarative
 * schedules in the dev environment and fire them while the dev session is
 * connected. With this config the dev session serves just
 * `activity-compute-metrics` (the one task the API triggers automatically on
 * upload) — and the schedule sync prunes any previously-registered dev crons.
 * Deploys keep using `trigger.config.ts` (the full set); to run everything
 * locally on purpose: `npm run trigger:dev:all`.
 */
export default defineConfig({
  project: "proj_xvhmhumoeeskbkdgkuxk",
  dirs: ["./src/domains/feature/activity/tasks"],
  maxDuration: 300,
  build: {
    // pino resolves its worker-thread transports at runtime, which breaks
    // esbuild bundling (worker.js never gets emitted).
    external: ["pino", "pino-pretty"],
  },
});
