import type { JsonValue } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";
import type { ObjectStorage } from "@/packages/object-storage";
import type { SpatialGrid, SpatialSource } from "@/packages/om-spatial";

import { WeatherMapReason } from "../errors";
import {
  activeWeatherMapLayers,
  findWeatherMapLayer,
  layerVariables,
  type WeatherMapLayer,
  WIND_DIRECTION_VARIABLE,
  WIND_GUST_VARIABLE,
  WIND_SPEED_VARIABLE,
  WIND_U_VARIABLE,
  WIND_V_VARIABLE,
} from "../layers";
import {
  activeWeatherMapModels,
  findWeatherMapModel,
  type WeatherMapModel,
} from "../models";
import type { WeatherMapRepository } from "../repositories/weathermap.repository";
import { laeaSpecFor, regridLaea } from "./laea-regrid";
import {
  deriveWindComponents,
  type EncodedLayerImage,
  encodeScalarLayer,
  encodeWindLayer,
} from "./layer-image";
import { isPointList, regridOctahedral } from "./reduced-gaussian";

const logger = createLogger("weathermap");

/** How far back a frame stays in the manifest — the hour in progress. */
const MANIFEST_LOOKBACK_MS = 60 * 60 * 1000;

// Design constants (RFC-0011 §16, user decisions 2026-07-15), not deployment
// config. Horizon is UNCAPPED — every valid time the model's run provides is
// rendered (distant hours arrive at the model's own 3/6-hourly granularity);
// per-invocation narrowing for dev/force-runs goes through
// `WeatherMapRefreshOverrides.horizonHours`. Past frames are pruned after 1 h
// — exactly when they drop out of the manifest.
const RETENTION_HOURS = 1;

/**
 * Target raster for reduced-Gaussian models (ECMWF IFS HRES native ~9 km ≈
 * 0.08°): 0.1° global — 3600×1800 keeps a real edge over the 0.25°
 * `ecmwf_ifs025` while staying in the same texture-size family as the
 * regular-grid globals (ICON global is 0.125°).
 */
const REGRID_WIDTH = 3600;
const REGRID_HEIGHT = 1800;

/**
 * Models handled concurrently by the IN-PROCESS paths — the orchestrator's
 * plan pass (`planRefresh`: one `latest.json` GET + one frame query per
 * model) and the full force-run/CLI pass (`refresh`). Bounded, not
 * `Promise.all` over all 20: each in-flight `refresh` model holds its current
 * valid time's grids in memory (~100 MB for a global 0.13° hour) and hits the
 * same archive host. (Valid times stay sequential in `refresh` for the same
 * memory reason; the fan-out child path gets `CHILD_HOUR_CONCURRENCY`.)
 */
const MODEL_CONCURRENCY = 4;

/**
 * Valid hours rendered concurrently inside ONE fan-out child
 * (`weathermap-render-model`), which has a whole machine to itself: 4
 * overlaps range reads with encodes across hours while stacking at most
 * ~800 MB (~120 MB of grids per global-model hour + encode buffers) — fits
 * the child's medium-1x (2 GB) machine with headroom. Raised from 2 after
 * long-horizon models took ~12 min per run (2026-07-16); tune further from
 * the run output's `profile` ratios, not by guessing.
 */
const CHILD_HOUR_CONCURRENCY = 4;

/** `map` with at most `limit` callbacks in flight; result order preserved. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Explicit per-layer miss counts (summed across models) for the summary:
 * `{ snowfall: 117 }` beats a bare total when reading a run's output. Layers
 * with zero misses stay out. */
function missingByLayer(
  layerStats: { layer: string; missingVariable: number }[],
): Record<string, number> {
  const byLayer: Record<string, number> = {};
  for (const stats of layerStats) {
    if (stats.missingVariable > 0) {
      byLayer[stats.layer] =
        (byLayer[stats.layer] ?? 0) + stats.missingVariable;
    }
  }
  return byLayer;
}

/**
 * Cumulative phase timings in ms — the run output's own profiler, for
 * spotting WHERE task-seconds (= Trigger cost) actually go. Summed across
 * hours that render CONCURRENTLY, so totals can exceed wall-clock; read the
 * RATIOS. `encodeMs` covers JS channel-packing + libvips WebP together;
 * `regridMs` is pure JS (reduced-Gaussian + LAEA resampling).
 */
export interface WeatherMapRenderProfile {
  fetchGridsMs: number;
  regridMs: number;
  encodeMs: number;
  uploadMs: number;
  dbMs: number;
}

const emptyProfile = (): WeatherMapRenderProfile => ({
  fetchGridsMs: 0,
  regridMs: 0,
  encodeMs: 0,
  uploadMs: 0,
  dbMs: 0,
});

const addProfile = (
  into: WeatherMapRenderProfile,
  from: WeatherMapRenderProfile,
): void => {
  into.fetchGridsMs += from.fetchGridsMs;
  into.regridMs += from.regridMs;
  into.encodeMs += from.encodeMs;
  into.uploadMs += from.uploadMs;
  into.dbMs += from.dbMs;
};

const roundProfile = (p: WeatherMapRenderProfile): WeatherMapRenderProfile => ({
  fetchGridsMs: Math.round(p.fetchGridsMs),
  regridMs: Math.round(p.regridMs),
  encodeMs: Math.round(p.encodeMs),
  uploadMs: Math.round(p.uploadMs),
  dbMs: Math.round(p.dbMs),
});

/**
 * Optional narrowing for a single refresh invocation (the force-run task and
 * the CLI): can only select within the enabled registry — a disabled
 * model/layer stays off. The cron task passes nothing (full active set).
 */
export interface WeatherMapRefreshOverrides {
  models?: string[];
  layers?: string[];
  horizonHours?: number;
}

/** The orchestrator's fan-out decision: which models have renderable work. */
export interface WeatherMapRefreshPlan {
  checked: number;
  /**
   * Models with at least one due (layer, valid time) — each becomes one
   * `weathermap-render-model` child run. `referenceTime` (ISO) identifies the
   * run that made the model due; it feeds the (model, run) idempotency key.
   */
  due: { model: string; referenceTime: string; dueFrames: number }[];
  errors: { model: string; message: string }[];
}

export interface WeatherMapRefreshSummary {
  checked: number;
  /** Models whose run had not advanced (nothing to render). */
  upToDate: number;
  rendered: number;
  /** Layer-frames skipped because the file lacks the layer's variable. */
  missingVariable: number;
  /**
   * The same misses made EXPLICIT per layer (summed across models), e.g.
   * `{ snowfall: 117 }` — so a run's output names WHAT was missing without
   * digging through `layerStats`.
   */
  missingByLayer: Record<string, number>;
  /** Valid hours skipped after a failed (and once-retried) archive read. */
  frameErrors: number;
  /** Where the task-seconds went (see WeatherMapRenderProfile). */
  profile: WeatherMapRenderProfile;
  pruned: number;
  errors: { model: string; message: string }[];
  /**
   * Per (model, layer) outcome of THIS run — the pivot's raw data. Only
   * pairs that had due work appear (an up-to-date pair renders nothing and
   * is omitted). `missingVariable` > 0 means the model's files lack that
   * layer's variable (e.g. snowfall outside winter).
   */
  layerStats: {
    model: string;
    layer: string;
    rendered: number;
    missingVariable: number;
  }[];
}

export interface WeatherMapCatalog {
  models: {
    model: string;
    label: string;
    provider: string;
    resolutionKm: number;
    /**
     * Layers this model ACTUALLY has fresh frames for — derived from the
     * frame table, never hardcoded (availability is empirical and seasonal:
     * snowfall appears in winter runs, some models lack certain fields).
     */
    layers: string[];
    /** Geographic coverage of the model's grid; null until first render. */
    coverage: {
      west: number;
      south: number;
      east: number;
      north: number;
    } | null;
    /** Newest run among fresh frames; null until first render. */
    run: string | null;
    /** Latest forecast hour currently rendered; null until first render. */
    validThrough: string | null;
  }[];
  layers: { layer: string; label: string; unit: string }[];
}

export interface WeatherMapManifest {
  model: string;
  layer: string;
  unit: string;
  run: string | null;
  frames: {
    validTime: string;
    runTime: string;
    url: string;
    width: number;
    height: number;
    bbox: { west: number; south: number; east: number; north: number };
    /**
     * Layer-shaped decode payload: wind = {uMin,uMax,vMin,vMax,gustMin,
     * gustMax,hasRealGust}, scalar = {min,max}.
     */
    scales: Record<string, number | boolean>;
  }[];
}

/**
 * The weather-map PNG pipeline (RFC-0011): renders per-valid-hour textures of
 * every registered layer (wind, temperature, precipitation, …) from
 * Open-Meteo's spatial `.om` archive into object storage, keyed by valid time
 * so newer runs repaint the same URL, and serves the frame manifests.
 */
export class WeatherMapService extends BaseUseCase {
  constructor(
    private readonly weatherMapRepository: WeatherMapRepository,
    private readonly spatialSource: SpatialSource,
    private readonly objectStorage: ObjectStorage,
  ) {
    super();
  }

  /**
   * The full IN-PROCESS pass (force-run task + CLI; the cron path fans out
   * via `planRefresh` → `refreshModelById` instead). Per enabled model: cheap
   * `latest.json` check → for each horizon valid time, render the layers
   * whose frame is missing or was painted by an older run — all layers of one
   * valid time share a single `.om` reader, so adding layers adds encode
   * work, not round-trips. Models fail independently. Finishes by pruning
   * expired frames.
   */
  async refresh(
    now: Date = new Date(),
    overrides: WeatherMapRefreshOverrides = {},
  ): Promise<WeatherMapRefreshSummary> {
    const summary: WeatherMapRefreshSummary = {
      checked: 0,
      upToDate: 0,
      rendered: 0,
      missingVariable: 0,
      missingByLayer: {},
      frameErrors: 0,
      profile: emptyProfile(),
      pruned: 0,
      errors: [],
      layerStats: [],
    };
    const models = activeWeatherMapModels(overrides.models);
    const layers = activeWeatherMapLayers(overrides.layers);
    const horizonHours = overrides.horizonHours;

    logger.info("weather-map refresh started", {
      models: models.length,
      layers: layers.map((l) => l.id),
      horizon: horizonHours ?? "model-max",
      concurrency: MODEL_CONCURRENCY,
    });
    // Models refresh CONCURRENTLY (bounded pool) — each is independent and
    // still fails independently; results fold into the summary in registry
    // order so logs/errors stay deterministic.
    const results = await mapLimit(models, MODEL_CONCURRENCY, async (model) => {
      const started = Date.now();
      try {
        // Hours stay sequential (concurrency 1): this path already runs
        // MODEL_CONCURRENCY models in one process (see the constants).
        const result = await this.refreshModel(
          model,
          now,
          layers,
          horizonHours,
          1,
        );
        logger.info("weather-map model done", {
          model: model.id,
          run: result.run,
          status: result.status,
          rendered: result.rendered,
          missingVariable: result.missingVariable,
          frameErrors: result.frameErrors,
          elapsedMs: Date.now() - started,
        });
        return { model, ...result };
      } catch (error) {
        logger.error("weather-map model refresh failed", {
          model: model.id,
          elapsedMs: Date.now() - started,
          error,
        });
        return {
          model,
          rendered: 0,
          missingVariable: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    for (const result of results) {
      summary.checked++;
      if ("error" in result) {
        summary.errors.push({
          model: result.model.id,
          message: result.error ?? "unknown error",
        });
        continue;
      }
      if (result.rendered === 0) summary.upToDate++;
      summary.rendered += result.rendered;
      summary.missingVariable += result.missingVariable;
      summary.frameErrors += result.frameErrors;
      addProfile(summary.profile, result.profile);
      for (const [layer, stats] of Object.entries(result.layerStats)) {
        summary.layerStats.push({ model: result.model.id, layer, ...stats });
      }
    }

    summary.missingByLayer = missingByLayer(summary.layerStats);
    summary.profile = roundProfile(summary.profile);
    summary.pruned = await this.prune(now);
    return summary;
  }

  /**
   * The orchestrator's cheap pass (RFC-0011 §8): per enabled model, one
   * `latest.json` GET + one frame query decide whether ANY (layer, valid
   * time) is due — no grid reads, no rendering. The cron task fans the `due`
   * list out to per-model render tasks. Models fail independently, exactly
   * like `refresh`.
   */
  async planRefresh(now: Date = new Date()): Promise<WeatherMapRefreshPlan> {
    const models = activeWeatherMapModels();
    const layers = activeWeatherMapLayers();
    const plan: WeatherMapRefreshPlan = { checked: 0, due: [], errors: [] };
    const results = await mapLimit(models, MODEL_CONCURRENCY, async (model) => {
      try {
        return { model, plan: await this.planModel(model, now, layers) };
      } catch (error) {
        return {
          model,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    for (const result of results) {
      plan.checked++;
      if ("error" in result) {
        plan.errors.push({
          model: result.model.id,
          message: result.error ?? "unknown error",
        });
        continue;
      }
      if (result.plan.status !== "due") continue;
      plan.due.push({
        model: result.model.id,
        referenceTime: result.plan.referenceTime.toISOString(),
        dueFrames: result.plan.work.reduce((n, w) => n + w.dueLayers.length, 0),
      });
    }
    return plan;
  }

  /**
   * Fan-out child entry (one `weathermap-render-model` run): render every due
   * frame of ONE model, with the child machine to itself. Re-plans from
   * `latest.json` rather than trusting the orchestrator's snapshot — if the
   * run advanced in between, the child renders the newer one. Throws on
   * failure (the task's retry owns recovery — there are no sibling models to
   * isolate here) and never prunes (the orchestrator owns pruning).
   */
  async refreshModelById(
    modelId: string,
    now: Date = new Date(),
  ): Promise<WeatherMapRefreshSummary> {
    const model = findWeatherMapModel(modelId);
    if (!model?.enabled) {
      throw new GenericError("FORM_ERROR", {
        reason: WeatherMapReason.UNKNOWN_MODEL,
        message: "Unknown weather-map model",
      });
    }
    const result = await this.refreshModel(
      model,
      now,
      this.activeLayers(),
      undefined,
      CHILD_HOUR_CONCURRENCY,
    );
    const layerStats = Object.entries(result.layerStats).map(
      ([layer, stats]) => ({
        model: model.id,
        layer,
        ...stats,
      }),
    );
    return {
      checked: 1,
      upToDate: result.rendered === 0 ? 1 : 0,
      rendered: result.rendered,
      missingVariable: result.missingVariable,
      missingByLayer: missingByLayer(layerStats),
      frameErrors: result.frameErrors,
      profile: result.profile,
      pruned: 0,
      errors: [],
      layerStats,
    };
  }

  async getCatalog(): Promise<WeatherMapCatalog> {
    // Availability/coverage come from the frames themselves — the registry
    // only knows identity (label/provider/resolution).
    const since = new Date(Date.now() - MANIFEST_LOOKBACK_MS);
    const fresh = await this.weatherMapRepository.findFreshFrames(since);
    const byModel = new Map<
      string,
      {
        layers: Set<string>;
        run: Date;
        validThrough: Date;
        coverage: { west: number; south: number; east: number; north: number };
      }
    >();
    for (const frame of fresh) {
      const entry = byModel.get(frame.model);
      if (!entry) {
        byModel.set(frame.model, {
          layers: new Set([frame.layer]),
          run: frame.runTime,
          validThrough: frame.validTime,
          coverage: {
            west: frame.west,
            south: frame.south,
            east: frame.east,
            north: frame.north,
          },
        });
        continue;
      }
      entry.layers.add(frame.layer);
      if (frame.runTime > entry.run) {
        entry.run = frame.runTime;
        // The bbox travels with the run — keep the newest run's coverage.
        entry.coverage = {
          west: frame.west,
          south: frame.south,
          east: frame.east,
          north: frame.north,
        };
      }
      if (frame.validTime > entry.validThrough) {
        entry.validThrough = frame.validTime;
      }
    }

    return {
      models: this.activeModels().map((m) => {
        const stats = byModel.get(m.id);
        return {
          model: m.id,
          label: m.label,
          provider: m.provider,
          resolutionKm: m.resolutionKm,
          layers: stats ? [...stats.layers].sort() : [],
          coverage: stats?.coverage ?? null,
          run: stats ? stats.run.toISOString() : null,
          validThrough: stats ? stats.validThrough.toISOString() : null,
        };
      }),
      layers: this.activeLayers().map((l) => ({
        layer: l.id,
        label: l.label,
        unit: l.unit,
      })),
    };
  }

  async getManifest(
    modelId: string,
    layerId: string,
  ): Promise<WeatherMapManifest> {
    this.requireActiveModel(modelId);
    const layer = this.requireActiveLayer(layerId);
    const since = new Date(Date.now() - MANIFEST_LOOKBACK_MS);
    const frames = await this.weatherMapRepository.findFrames(
      modelId,
      since,
      layerId,
    );
    const newestRun = frames.reduce<Date | null>(
      (max, f) => (max === null || f.runTime > max ? f.runTime : max),
      null,
    );
    return {
      model: modelId,
      layer: layerId,
      unit: layer.unit,
      run: newestRun ? newestRun.toISOString() : null,
      frames: frames.map((f) => ({
        validTime: f.validTime.toISOString(),
        runTime: f.runTime.toISOString(),
        url: this.frameUrl(
          modelId,
          layerId,
          f.objectKey,
          f.validTime,
          f.runTime,
        ),
        width: f.width,
        height: f.height,
        bbox: { west: f.west, south: f.south, east: f.east, north: f.north },
        scales: f.scales as Record<string, number | boolean>,
      })),
    };
  }

  /** Proxy read for environments without a public bucket URL. */
  async getFrameObject(
    modelId: string,
    layerId: string,
    file: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    this.requireActiveModel(modelId);
    this.requireActiveLayer(layerId);
    const validTime = parseFrameFile(file);
    if (!validTime) {
      throw new GenericError("NOT_FOUND", {
        reason: WeatherMapReason.FRAME_NOT_FOUND,
        message: "Unknown weather-map frame",
      });
    }
    const frame = await this.weatherMapRepository.findFrame(
      modelId,
      layerId,
      validTime,
    );
    if (!frame) {
      throw new GenericError("NOT_FOUND", {
        reason: WeatherMapReason.FRAME_NOT_FOUND,
        message: "Unknown weather-map frame",
      });
    }
    // Content type follows the STORED object, not the requested file name —
    // during the container transition a `.webp` URL can still be backed by
    // a not-yet-rerendered `.png` row.
    const body = await this.objectStorage.get(frame.objectKey);
    const contentType = frame.objectKey.endsWith(".png")
      ? "image/png"
      : "image/webp";
    return { body, contentType };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private activeModels(): WeatherMapModel[] {
    return activeWeatherMapModels();
  }

  private activeLayers(): WeatherMapLayer[] {
    return activeWeatherMapLayers();
  }

  private requireActiveModel(modelId: string): void {
    const model = findWeatherMapModel(modelId);
    const active = this.activeModels().some((m) => m.id === modelId);
    if (!model || !active) {
      throw new GenericError("FORM_ERROR", {
        reason: WeatherMapReason.UNKNOWN_MODEL,
        message: "Unknown weather-map model",
      });
    }
  }

  private requireActiveLayer(layerId: string): WeatherMapLayer {
    const layer = findWeatherMapLayer(layerId);
    const active = this.activeLayers().some((l) => l.id === layerId);
    if (!layer || !active) {
      throw new GenericError("FORM_ERROR", {
        reason: WeatherMapReason.UNKNOWN_LAYER,
        message: "Unknown weather-map layer",
      });
    }
    return layer;
  }

  /**
   * Cheap due-work computation for one model: `latest.json` + one frame
   * query — no grid reads. Shared by the orchestrator's fan-out decision
   * (`planRefresh`) and the render paths, so "due" can never mean two
   * different things.
   */
  private async planModel(
    model: WeatherMapModel,
    now: Date,
    layers: WeatherMapLayer[],
    horizonHours?: number,
  ): Promise<{
    run: string;
    referenceTime: Date;
    bbox: { west: number; south: number; east: number; north: number };
    status: "run-uploading" | "up-to-date" | "due";
    work: { validTime: Date; dueLayers: WeatherMapLayer[] }[];
  }> {
    const latest = await this.spatialSource.fetchLatest(model.id);
    const referenceTime = latest.referenceTime;
    const base = {
      run: referenceTime.toISOString(),
      referenceTime,
      bbox: latest.bbox,
    };
    // A run mid-upload lists valid times whose files don't exist yet — skip
    // the whole run; the next tick sees it completed.
    if (!latest.completed) {
      return { ...base, status: "run-uploading", work: [] };
    }

    const windowStart = new Date(now.getTime() - MANIFEST_LOOKBACK_MS);
    // No default upper bound — the run's own horizon IS the horizon; an
    // override (force-run/CLI) narrows it for cheap dev renders.
    const windowEnd =
      horizonHours === undefined
        ? undefined
        : new Date(now.getTime() + horizonHours * 60 * 60 * 1000);
    const inWindow = latest.validTimes.filter(
      (t) => t >= windowStart && (windowEnd === undefined || t <= windowEnd),
    );
    if (inWindow.length === 0) {
      return { ...base, status: "up-to-date", work: [] };
    }

    // One query covers every layer's state for the window.
    const existing = await this.weatherMapRepository.findFrames(
      model.id,
      windowStart,
    );
    const byLayerAndTime = new Map(
      existing.map((f) => [`${f.layer}|${f.validTime.getTime()}`, f]),
    );
    // Due = no frame yet, or painted by an older run. Same run → skip: this
    // is what makes the 15-min poll idempotent between model publications.
    const work = inWindow
      .map((validTime) => ({
        validTime,
        dueLayers: layers.filter((layer) => {
          const frame = byLayerAndTime.get(
            `${layer.id}|${validTime.getTime()}`,
          );
          return !frame || frame.runTime < referenceTime;
        }),
      }))
      .filter((w) => w.dueLayers.length > 0);
    return { ...base, status: work.length > 0 ? "due" : "up-to-date", work };
  }

  /** Render every due (layer, valid time) of one model. */
  private async refreshModel(
    model: WeatherMapModel,
    now: Date,
    layers: WeatherMapLayer[],
    horizonHours: number | undefined,
    hourConcurrency: number,
  ): Promise<{
    rendered: number;
    missingVariable: number;
    run: string;
    status: "rendered" | "up-to-date" | "run-uploading";
    frameErrors: number;
    profile: WeatherMapRenderProfile;
    layerStats: Record<string, { rendered: number; missingVariable: number }>;
  }> {
    const plan = await this.planModel(model, now, layers, horizonHours);
    if (plan.status !== "due") {
      return {
        rendered: 0,
        missingVariable: 0,
        run: plan.run,
        status: plan.status,
        frameErrors: 0,
        profile: emptyProfile(),
        layerStats: {},
      };
    }

    // One accumulator for the whole model render — concurrent hours add into
    // it (single-threaded JS, so plain += is safe).
    const profile = emptyProfile();
    const hourResults = await mapLimit(
      plan.work,
      hourConcurrency,
      ({ validTime, dueLayers }) =>
        this.renderValidTime(
          model,
          plan.referenceTime,
          plan.bbox,
          validTime,
          dueLayers,
          profile,
        ),
    );

    // Fold in valid-time order so counters/stats stay deterministic even when
    // hours rendered concurrently.
    let rendered = 0;
    let missingVariable = 0;
    let frameErrors = 0;
    const layerStats: Record<
      string,
      { rendered: number; missingVariable: number }
    > = {};
    const layerStat = (layerId: string) => {
      layerStats[layerId] ??= { rendered: 0, missingVariable: 0 };
      return layerStats[layerId];
    };
    for (const hour of hourResults) {
      if (hour.frameError) {
        frameErrors++;
        continue;
      }
      for (const layerId of hour.rendered) {
        rendered++;
        layerStat(layerId).rendered++;
      }
      for (const layerId of hour.missingVariable) {
        missingVariable++;
        layerStat(layerId).missingVariable++;
      }
    }
    return {
      rendered,
      missingVariable,
      frameErrors,
      run: plan.run,
      status: rendered > 0 ? "rendered" : "up-to-date",
      profile: roundProfile(profile),
      layerStats,
    };
  }

  /** Render one valid time's due layers: one `.om` reader session for the
   * union of their variables, then encode + upload + upsert per layer. */
  private async renderValidTime(
    model: WeatherMapModel,
    referenceTime: Date,
    bbox: { west: number; south: number; east: number; north: number },
    validTime: Date,
    dueLayers: WeatherMapLayer[],
    profile: WeatherMapRenderProfile,
  ): Promise<{
    frameError: boolean;
    rendered: string[];
    missingVariable: string[];
  }> {
    // One valid time failing (a transient archive/network error) must not
    // kill the model's other hours — retry once, then skip just this hour;
    // the next tick retries it anyway (its frame stays missing/stale → still
    // due).
    const variables = [...new Set(dueLayers.flatMap((l) => layerVariables(l)))];
    let frameBBox = bbox;
    let grids: Map<string, SpatialGrid>;
    try {
      const fetchStart = performance.now();
      grids = await this.fetchGridsWithRetry(
        model.id,
        referenceTime,
        validTime,
        variables,
      );
      profile.fetchGridsMs += performance.now() - fetchStart;
      const regridStart = performance.now();
      // Reduced-Gaussian models (ECMWF IFS HRES) arrive as a flattened point
      // list, not a raster — resample onto the regular target grid before
      // the encoders see them. A non-octahedral point list throws here and
      // fails the whole hour (never ship an unopenable PNG).
      for (const [name, grid] of grids) {
        if (isPointList(grid)) {
          grids.set(name, regridOctahedral(grid, REGRID_WIDTH, REGRID_HEIGHT));
        }
      }
      // LAEA-projected models (UKMO UKV) arrive as native projected rasters —
      // resample onto the spec's regular lat/lon target grid, and serve THAT
      // grid's bbox: the archive's bbox describes the projected domain's
      // lat/lon envelope, not our target raster. A source-shape mismatch
      // throws here and fails the hour (never ship a mis-georeferenced frame).
      const laeaSpec = laeaSpecFor(model.id);
      if (laeaSpec) {
        for (const [name, grid] of grids) {
          grids.set(name, regridLaea(grid, laeaSpec));
        }
        frameBBox = {
          west: laeaSpec.target.west,
          south: laeaSpec.target.south,
          east: laeaSpec.target.east,
          north: laeaSpec.target.north,
        };
      }
      profile.regridMs += performance.now() - regridStart;
    } catch (error) {
      logger.warn("weather-map valid time failed; skipping this hour", {
        model: model.id,
        validTime: validTime.toISOString(),
        error,
      });
      return { frameError: true, rendered: [], missingVariable: [] };
    }

    const rendered: string[] = [];
    const missingVariable: string[] = [];
    for (const layer of dueLayers) {
      const encodeStart = performance.now();
      const encoded = await this.encodeLayer(layer, grids);
      profile.encodeMs += performance.now() - encodeStart;
      if (!encoded) {
        // The file genuinely lacks this layer's variable (e.g. snowfall in
        // summer runs) — not an error; the layer's manifest stays empty.
        logger.debug("weather-map layer variable missing", {
          model: model.id,
          layer: layer.id,
          validTime: validTime.toISOString(),
        });
        missingVariable.push(layer.id);
        continue;
      }
      const objectKey = frameObjectKey(model.id, layer.id, validTime);
      // The PNG→WebP container switch changed this hour's object key: the
      // row is the bucket's only index, so the superseded object must go
      // NOW or it is orphaned forever (prune deletes by row key only).
      const findStart = performance.now();
      const previous = await this.weatherMapRepository.findFrame(
        model.id,
        layer.id,
        validTime,
      );
      profile.dbMs += performance.now() - findStart;
      const putStart = performance.now();
      await this.objectStorage.put(objectKey, encoded.image, {
        contentType: "image/webp",
        // Manifest URLs carry ?v=<run> — every repaint is a NEW URL, so the
        // bytes behind any one URL never change and may cache forever. This
        // is what lets the CDN keep serving repainted keys correctly without
        // explicit invalidation.
        cacheControl: "public, max-age=31536000, immutable",
      });
      profile.uploadMs += performance.now() - putStart;
      const upsertStart = performance.now();
      await this.weatherMapRepository.upsertFrame({
        model: model.id,
        layer: layer.id,
        validTime,
        runTime: referenceTime,
        objectKey,
        width: encoded.width,
        height: encoded.height,
        west: frameBBox.west,
        south: frameBBox.south,
        east: frameBBox.east,
        north: frameBBox.north,
        scales: encoded.scales as unknown as JsonValue,
        renderedAt: new Date(),
      });
      profile.dbMs += performance.now() - upsertStart;
      if (previous && previous.objectKey !== objectKey) {
        try {
          await this.objectStorage.delete(previous.objectKey);
        } catch (error) {
          // Best-effort: a failed delete only leaks one superseded object.
          logger.warn("weather-map superseded object delete failed", {
            objectKey: previous.objectKey,
            error,
          });
        }
      }
      rendered.push(layer.id);
      logger.debug("weather-map frame rendered", {
        model: model.id,
        layer: layer.id,
        validTime: validTime.toISOString(),
      });
    }
    return { frameError: false, rendered, missingVariable };
  }

  /** One retry — transient archive/network blips are common enough on cold
   * starts that a single immediate retry saves a whole hour's frames. */
  private async fetchGridsWithRetry(
    model: string,
    referenceTime: Date,
    validTime: Date,
    variables: string[],
  ): Promise<Map<string, SpatialGrid>> {
    try {
      return await this.spatialSource.fetchGrids(
        model,
        referenceTime,
        validTime,
        variables,
      );
    } catch {
      return this.spatialSource.fetchGrids(
        model,
        referenceTime,
        validTime,
        variables,
      );
    }
  }

  /** Kind dispatch — a new packing kind adds a case here + an encoder. */
  private async encodeLayer(
    layer: WeatherMapLayer,
    grids: Map<string, SpatialGrid>,
  ): Promise<EncodedLayerImage | null> {
    if (layer.kind === "wind") {
      let u = grids.get(WIND_U_VARIABLE);
      let v = grids.get(WIND_V_VARIABLE);
      if (!u || !v) {
        // Some models publish speed + direction instead of components
        // (GeoSphere/ItaliaMeteo/KNMI/DMI/MET Norway) — derive u/v.
        const speed = grids.get(WIND_SPEED_VARIABLE);
        const direction = grids.get(WIND_DIRECTION_VARIABLE);
        if (!speed || !direction) return null;
        ({ u, v } = deriveWindComponents(speed, direction));
      }
      return encodeWindLayer(u, v, grids.get(WIND_GUST_VARIABLE) ?? null);
    }
    const grid = grids.get(layer.variable);
    if (!grid) return null;
    return encodeScalarLayer(grid);
  }

  /** Delete frames (rows + objects) behind the retention cutoff. Public
   * because the orchestrator task owns pruning on the fan-out path (children
   * never prune); `refresh` keeps calling it at the end of a full pass. */
  async prune(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_HOURS * 60 * 60 * 1000);
    const expired = await this.weatherMapRepository.findOlderThan(cutoff);
    if (expired.length === 0) return 0;
    const deletable: number[] = [];
    for (const frame of expired) {
      try {
        await this.objectStorage.delete(frame.objectKey);
        deletable.push(frame.id);
      } catch (error) {
        // The row is the index — keep it so the object is retried next prune
        // rather than orphaned in the bucket.
        logger.warn("weather-map object delete failed; will retry", {
          objectKey: frame.objectKey,
          error,
        });
      }
    }
    await this.weatherMapRepository.deleteByIds(deletable);
    logger.info("weather-map frames pruned", {
      pruned: deletable.length,
      failed: expired.length - deletable.length,
    });
    return deletable.length;
  }

  private frameUrl(
    modelId: string,
    layerId: string,
    objectKey: string,
    validTime: Date,
    runTime: Date,
  ): string {
    // Frames repaint IN PLACE (a newer run overwrites the same key), so the
    // bare URL is cacheable-stale by design. The run stamp busts every cache
    // in the chain — CDN edge, URLSession, proxies — because a repaint mints
    // a DIFFERENT URL; the objects themselves upload immutable.
    const version = `v=${Math.floor(runTime.getTime() / 1000)}`;
    const publicBase = this.config.objectStorage.publicBaseUrl;
    if (publicBase) {
      return `${publicBase.replace(/\/+$/, "")}/${objectKey}?${version}`;
    }
    return `/v1/weather-map/frames/${modelId}/${layerId}/${frameFileName(validTime)}?${version}`;
  }
}

/** `2026-07-15T12:00:00.000Z` → `2026-07-15T1200Z.webp` (compact, key-safe). */
export function frameFileName(validTime: Date): string {
  const iso = validTime.toISOString();
  return `${iso.slice(0, 13)}${iso.slice(14, 16)}Z.webp`;
}

export function frameObjectKey(
  modelId: string,
  layerId: string,
  validTime: Date,
): string {
  return `weather-map/${modelId}/${layerId}/${frameFileName(validTime)}`;
}

/** Inverse of `frameFileName`; null when the name doesn't parse to a time.
 * `.png` stays accepted for the container transition: manifests issued
 * before the WebP switch still point old clients at `.png` proxy paths
 * (the object served comes from the ROW's key either way). */
export function parseFrameFile(file: string): Date | null {
  const match = file.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z\.(?:webp|png)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
