import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_xvhmhumoeeskbkdgkuxk",
  dirs: ["./src/**/tasks"],
  maxDuration: 300,
  build: {
    // pino resolves its worker-thread transports at runtime, which breaks
    // esbuild bundling (worker.js never gets emitted). sharp ships prebuilt
    // native binaries (libvips) that esbuild must not try to bundle.
    external: ["pino", "pino-pretty", "sharp"],
  },
});
