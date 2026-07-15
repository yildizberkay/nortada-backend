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
import {
  deriveWindComponents,
  type EncodedLayerPng,
  encodeScalarLayer,
  encodeWindLayer,
} from "./layer-png";

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
 * Models refreshed concurrently. Bounded, not `Promise.all` over all 20: each
 * in-flight model holds its current valid time's grids in memory (~100 MB for
 * a global 0.13° hour) and hits the same archive host — 4 keeps a cold-start
 * backfill inside the task's `maxDuration` without memory/rate-limit risk.
 * (Valid times WITHIN a model stay sequential for the same memory reason.)
 */
const MODEL_CONCURRENCY = 4;

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

export interface WeatherMapRefreshSummary {
  checked: number;
  /** Models whose run had not advanced (nothing to render). */
  upToDate: number;
  rendered: number;
  /** Layer-frames skipped because the file lacks the layer's variable. */
  missingVariable: number;
  /** Valid hours skipped after a failed (and once-retried) archive read. */
  frameErrors: number;
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
   * Task entry point (every 15 min). Per enabled model: cheap `latest.json`
   * check → for each horizon valid time, render the layers whose frame is
   * missing or was painted by an older run — all layers of one valid time
   * share a single `.om` reader, so adding layers adds encode work, not
   * round-trips. Models fail independently. Finishes by pruning expired
   * frames.
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
      frameErrors: 0,
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
        const result = await this.refreshModel(
          model,
          now,
          layers,
          horizonHours,
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
      for (const [layer, stats] of Object.entries(result.layerStats)) {
        summary.layerStats.push({ model: result.model.id, layer, ...stats });
      }
    }

    summary.pruned = await this.prune(now);
    return summary;
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
        url: this.frameUrl(modelId, layerId, f.objectKey, f.validTime),
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
  ): Promise<Buffer> {
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
    return this.objectStorage.get(frame.objectKey);
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

  /** Render every due (layer, valid time) of one model. */
  private async refreshModel(
    model: WeatherMapModel,
    now: Date,
    layers: WeatherMapLayer[],
    horizonHours: number | undefined,
  ): Promise<{
    rendered: number;
    missingVariable: number;
    run: string;
    status: "rendered" | "up-to-date" | "run-uploading";
    frameErrors: number;
    layerStats: Record<string, { rendered: number; missingVariable: number }>;
  }> {
    const latest = await this.spatialSource.fetchLatest(model.id);
    const run = latest.referenceTime.toISOString();
    // A run mid-upload lists valid times whose files don't exist yet — skip
    // the whole run; the next tick sees it completed.
    if (!latest.completed) {
      return {
        rendered: 0,
        missingVariable: 0,
        run,
        status: "run-uploading",
        frameErrors: 0,
        layerStats: {},
      };
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
      return {
        rendered: 0,
        missingVariable: 0,
        run,
        status: "up-to-date",
        frameErrors: 0,
        layerStats: {},
      };
    }

    // One query covers every layer's state for the window.
    const existing = await this.weatherMapRepository.findFrames(
      model.id,
      windowStart,
    );
    const byLayerAndTime = new Map(
      existing.map((f) => [`${f.layer}|${f.validTime.getTime()}`, f]),
    );

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
    for (const validTime of inWindow) {
      // Due = no frame yet, or painted by an older run. Same run → skip: this
      // is what makes the 15-min poll idempotent between model publications.
      const dueLayers = layers.filter((layer) => {
        const frame = byLayerAndTime.get(`${layer.id}|${validTime.getTime()}`);
        return !frame || frame.runTime < latest.referenceTime;
      });
      if (dueLayers.length === 0) continue;

      // One reader per file: the union of every due layer's variables comes
      // back in a single range-read session. One valid time failing (a
      // transient archive/network error) must not kill the model's other
      // hours — retry once, then skip just this hour; the next tick retries
      // it anyway (its frame stays missing/stale → still due).
      const variables = [
        ...new Set(dueLayers.flatMap((l) => layerVariables(l))),
      ];
      let grids: Map<string, SpatialGrid>;
      try {
        grids = await this.fetchGridsWithRetry(
          model.id,
          latest.referenceTime,
          validTime,
          variables,
        );
      } catch (error) {
        frameErrors++;
        logger.warn("weather-map valid time failed; skipping this hour", {
          model: model.id,
          validTime: validTime.toISOString(),
          error,
        });
        continue;
      }

      for (const layer of dueLayers) {
        const encoded = this.encodeLayer(layer, grids);
        if (!encoded) {
          // The file genuinely lacks this layer's variable (e.g. snowfall in
          // summer runs) — not an error; the layer's manifest stays empty.
          logger.debug("weather-map layer variable missing", {
            model: model.id,
            layer: layer.id,
            validTime: validTime.toISOString(),
          });
          missingVariable++;
          layerStat(layer.id).missingVariable++;
          continue;
        }
        const objectKey = frameObjectKey(model.id, layer.id, validTime);
        await this.objectStorage.put(objectKey, encoded.png, {
          contentType: "image/png",
        });
        await this.weatherMapRepository.upsertFrame({
          model: model.id,
          layer: layer.id,
          validTime,
          runTime: latest.referenceTime,
          objectKey,
          width: encoded.width,
          height: encoded.height,
          west: latest.bbox.west,
          south: latest.bbox.south,
          east: latest.bbox.east,
          north: latest.bbox.north,
          scales: encoded.scales as unknown as JsonValue,
          renderedAt: new Date(),
        });
        rendered++;
        layerStat(layer.id).rendered++;
        logger.debug("weather-map frame rendered", {
          model: model.id,
          layer: layer.id,
          validTime: validTime.toISOString(),
        });
      }
    }
    return {
      rendered,
      missingVariable,
      frameErrors,
      run,
      status: rendered > 0 ? "rendered" : "up-to-date",
      layerStats,
    };
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
  private encodeLayer(
    layer: WeatherMapLayer,
    grids: Map<string, SpatialGrid>,
  ): EncodedLayerPng | null {
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

  /** Delete frames (rows + objects) behind the retention cutoff. */
  private async prune(now: Date): Promise<number> {
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
  ): string {
    const publicBase = this.config.objectStorage.publicBaseUrl;
    if (publicBase) {
      return `${publicBase.replace(/\/+$/, "")}/${objectKey}`;
    }
    return `/v1/weather-map/frames/${modelId}/${layerId}/${frameFileName(validTime)}`;
  }
}

/** `2026-07-15T12:00:00.000Z` → `2026-07-15T1200Z.png` (compact, key-safe). */
export function frameFileName(validTime: Date): string {
  const iso = validTime.toISOString();
  return `${iso.slice(0, 13)}${iso.slice(14, 16)}Z.png`;
}

export function frameObjectKey(
  modelId: string,
  layerId: string,
  validTime: Date,
): string {
  return `weather-map/${modelId}/${layerId}/${frameFileName(validTime)}`;
}

/** Inverse of `frameFileName`; null when the name doesn't parse to a time. */
export function parseFrameFile(file: string): Date | null {
  const match = file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z\.png$/);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
