/**
 * Force-run the weather-map render pipeline from the terminal — no Trigger.dev
 * needed. Runs the full in-process `refresh()` pass (the cron path fans out
 * per model instead — RFC-0011 §8); the run-advance idempotence applies
 * either way: an unchanged run is a cheap no-op.
 *
 *   npm run weathermap:render                                  # full active set
 *   npm run weathermap:render -- --models=dwd_icon_eu          # one model
 *   npm run weathermap:render -- --models=dwd_icon_eu,dwd_icon_d2 \
 *     --layers=wind,temperature --horizon=3
 */
import { initializeForTrigger } from "@/app/initialize-services";
import { buildContainer } from "@/container";
import { createDBManagerForTrigger } from "@/db/db.manager";

function csvArg(name: string): string[] | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  const values = arg
    ?.slice(name.length + 3)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : undefined;
}

function numberArg(name: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  const value = Number(arg.slice(name.length + 3));
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`--${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

/**
 * Model × layer pivot of this run's outcome. Cells: rendered frame count,
 * `miss` = the model's files lack the layer's variable, `·` = nothing was
 * due (already up to date), `ERROR` = the whole model failed.
 */
function printPivot(summary: {
  layerStats: {
    model: string;
    layer: string;
    rendered: number;
    missingVariable: number;
  }[];
  errors: { model: string; message: string }[];
}): void {
  const failed = new Set(summary.errors.map((e) => e.model));
  const models = [
    ...new Set([...summary.layerStats.map((s) => s.model), ...failed]),
  ];
  if (models.length === 0) {
    console.log("(nothing rendered — everything up to date)");
    return;
  }
  const layers = [...new Set(summary.layerStats.map((s) => s.layer))];
  const byKey = new Map(
    summary.layerStats.map((s) => [`${s.model}|${s.layer}`, s]),
  );
  const cell = (model: string, layer: string): string => {
    if (failed.has(model)) return "ERROR";
    const stats = byKey.get(`${model}|${layer}`);
    if (!stats) return "·";
    if (stats.rendered > 0 && stats.missingVariable > 0) {
      return `${stats.rendered} (+${stats.missingVariable} miss)`;
    }
    if (stats.missingVariable > 0) return `miss(${stats.missingVariable})`;
    return String(stats.rendered);
  };
  console.table(
    models.map((model) => ({
      model,
      ...Object.fromEntries(layers.map((l) => [l, cell(model, l)])),
    })),
  );
}

async function main() {
  // Relaxes the prod JWT-length rule the same way background tasks do — this
  // process never signs tokens.
  process.env.TRIGGER_WORKER = "true";
  initializeForTrigger();
  const db = await createDBManagerForTrigger();
  try {
    const overrides = {
      models: csvArg("models"),
      layers: csvArg("layers"),
      horizonHours: numberArg("horizon"),
    };
    console.log("weathermap force-run", JSON.stringify(overrides));
    const started = Date.now();
    const summary = await buildContainer(db).weatherMapService.refresh(
      new Date(),
      overrides,
    );
    const { layerStats, ...totals } = summary;
    console.log(JSON.stringify(totals, null, 2));
    printPivot(summary);
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (summary.errors.length > 0) process.exitCode = 1;
  } finally {
    await db.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
