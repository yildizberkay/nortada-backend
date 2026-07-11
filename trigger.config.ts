import { defineConfig } from "@trigger.dev/sdk";

// NOTE: `project` is a placeholder until a real Trigger.dev project is created
// (see docs/otonom-kararlar.md). It only matters for `trigger:dev`/deploy — the
// HTTP server and unit tests never touch it. Set TRIGGER_PROJECT_ID to override.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID ?? "proj_splash_placeholder",
  dirs: ["./src/**/tasks"],
  maxDuration: 300,
});
