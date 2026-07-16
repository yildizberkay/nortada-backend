import { createMockConfig } from "@tests/helpers/mock-config";
import { globalConfig } from "@/app/global-config";
import type { WeatherMapFrame } from "@/db";
import { GenericError } from "@/packages/error";
import type { ObjectStorage } from "@/packages/object-storage";
import type {
  SpatialGrid,
  SpatialLatest,
  SpatialSource,
} from "@/packages/om-spatial";

import type { WeatherMapRepository } from "../repositories/weathermap.repository";
import {
  adaptiveHourConcurrency,
  frameFileName,
  frameObjectKey,
  parseFrameFile,
  WeatherMapService,
} from "./weathermap.service";

const NOW = new Date("2026-07-15T10:30:00Z");
const RUN = new Date("2026-07-15T09:00:00Z");
const OLDER_RUN = new Date("2026-07-15T06:00:00Z");
const BBOX = { west: -3.94, south: 43.18, east: 20.34, north: 58.08 };
const NOON = new Date("2026-07-15T12:00:00Z");

const hoursFrom = (base: Date, hours: number[]): Date[] =>
  hours.map((h) => new Date(base.getTime() + h * 3600_000));

const latest = (over: Partial<SpatialLatest> = {}): SpatialLatest => ({
  completed: true,
  referenceTime: RUN,
  // 09:00Z run: T+0 … T+14 hourly.
  validTimes: hoursFrom(
    RUN,
    Array.from({ length: 15 }, (_, i) => i),
  ),
  bbox: BBOX,
  ...over,
});

const spatialGrid = (data: number[]): SpatialGrid => ({
  width: 2,
  height: 2,
  data: Float32Array.from(data),
});

/** Grids for every registered variable — full render on every layer. */
const allGrids = (): Map<string, SpatialGrid> =>
  new Map([
    ["wind_u_component_10m", spatialGrid([1, -1, 2, 0])],
    ["wind_v_component_10m", spatialGrid([0, 0, 0, 4])],
    ["wind_gusts_10m", spatialGrid([5, 5, 5, 5])],
    ["temperature_2m", spatialGrid([10, 20, 30, 40])],
    ["precipitation", spatialGrid([0, 1, 2, 3])],
    ["snowfall", spatialGrid([0, 0, 1, 2])],
  ]);

const frame = (
  model: string,
  layer: string,
  validTime: Date,
  over: Partial<WeatherMapFrame> = {},
): WeatherMapFrame => ({
  id: 1,
  uid: "frame-uid",
  model,
  layer,
  validTime,
  runTime: RUN,
  objectKey: frameObjectKey(model, layer, validTime),
  width: 2,
  height: 2,
  ...BBOX,
  scales: { min: 0, max: 1 },
  renderedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const mockRepo = {
  findFrames: jest.fn(),
  findFreshFrames: jest.fn(),
  findFrame: jest.fn(),
  upsertFrame: jest.fn(),
  findOlderThan: jest.fn(),
  deleteByIds: jest.fn(),
} as unknown as jest.Mocked<WeatherMapRepository>;

const mockSource = {
  fetchLatest: jest.fn(),
  fetchGrids: jest.fn(),
} as unknown as jest.Mocked<SpatialSource>;

const mockStorage = {
  put: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
} as unknown as jest.Mocked<ObjectStorage>;

const setConfig = (publicBaseUrl?: string) => {
  const config = createMockConfig();
  config.objectStorage.publicBaseUrl = publicBaseUrl;
  (globalConfig as unknown as { _config: unknown })._config = config;
};

// Registry narrowing is per-invocation now (no env config) — tests pass this
// to refresh() to stay deterministic on one model.
const D2 = { models: ["dwd_icon_d2"] };

describe("WeatherMapService", () => {
  let service: WeatherMapService;

  beforeEach(() => {
    jest.clearAllMocks();
    setConfig();
    service = new WeatherMapService(mockRepo, mockSource, mockStorage);
    mockRepo.findFrames.mockResolvedValue([]);
    mockRepo.findFreshFrames.mockResolvedValue([]);
    mockRepo.findOlderThan.mockResolvedValue([]);
    mockSource.fetchLatest.mockResolvedValue(latest());
    // A FRESH map per call — the real client returns a new Map per fetch,
    // and the service now consumes (deletes from) the map it is given.
    mockSource.fetchGrids.mockImplementation(async () => allGrids());
  });

  describe("refresh", () => {
    it("renders every layer of every horizon valid time when nothing exists", async () => {
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [NOON] }));

      const summary = await service.refresh(NOW, D2);

      // 1 valid time × 4 layers (wind, temperature, precipitation, snowfall).
      expect(summary).toMatchObject({
        checked: 1,
        rendered: 4,
        missingVariable: 0,
        errors: [],
      });
      // One reader session for the valid time — the union of variables.
      expect(mockSource.fetchGrids).toHaveBeenCalledTimes(1);
      const requested = mockSource.fetchGrids.mock.calls[0][3];
      expect(requested).toEqual(
        expect.arrayContaining([
          "wind_u_component_10m",
          "wind_v_component_10m",
          "wind_gusts_10m",
          "temperature_2m",
          "precipitation",
          "snowfall",
        ]),
      );
      // Objects upload immutable — the manifest's `?v=<run>` stamp mints a
      // new URL when a newer run repaints the same key.
      expect(mockStorage.put).toHaveBeenCalledWith(
        "weather-map/dwd_icon_d2/wind/2026-07-15T1200Z.webp",
        expect.any(Buffer),
        {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000, immutable",
        },
      );
      expect(mockStorage.put).toHaveBeenCalledWith(
        "weather-map/dwd_icon_d2/temperature/2026-07-15T1200Z.webp",
        expect.any(Buffer),
        {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000, immutable",
        },
      );
      const windUpsert = mockRepo.upsertFrame.mock.calls
        .map(([values]) => values)
        .find((v) => v.layer === "wind");
      expect(windUpsert).toMatchObject({
        model: "dwd_icon_d2",
        runTime: RUN,
        scales: expect.objectContaining({ uMax: 2, hasRealGust: true }),
      });
      const tempUpsert = mockRepo.upsertFrame.mock.calls
        .map(([values]) => values)
        .find((v) => v.layer === "temperature");
      expect(tempUpsert).toMatchObject({
        scales: { min: 10, max: 40 },
      });
      // The run output carries its own profiler — the native compression
      // really ran (sharp), bytes were uploaded, and every phase is a
      // non-negative cumulative counter. The memory trio (measured hour
      // bytes, chosen concurrency, peak RSS) is what sizes the machine.
      expect(summary.profile.webpMs).toBeGreaterThan(0);
      expect(summary.profile.uploadedBytes).toBeGreaterThan(0);
      expect(summary.profile.wallMs).toBeGreaterThan(0);
      expect(summary.profile.hourGridBytes).toBeGreaterThan(0);
      expect(summary.profile.hourConcurrency).toBeGreaterThanOrEqual(1);
      expect(summary.profile.maxRssBytes).toBeGreaterThan(0);
      for (const phase of Object.values(summary.profile)) {
        expect(phase).toBeGreaterThanOrEqual(0);
      }
    });

    it("renders the run's FULL remaining horizon by default (no cap)", async () => {
      const farFuture = new Date("2026-07-20T12:00:00Z"); // T+5 days
      mockSource.fetchLatest.mockResolvedValue(
        latest({
          validTimes: [
            ...hoursFrom(
              RUN,
              Array.from({ length: 15 }, (_, i) => i),
            ),
            farFuture,
          ],
        }),
      );

      const summary = await service.refresh(NOW, D2);

      // Lookback drops 09:00; 10:00 … 23:00 (14) + the distant hour all render.
      expect(summary.rendered).toBe(15 * 4);
      expect(mockSource.fetchGrids).toHaveBeenCalledTimes(15);
      expect(mockSource.fetchGrids).toHaveBeenCalledWith(
        "dwd_icon_d2",
        RUN,
        farFuture,
        expect.any(Array),
      );
    });

    it("skips frames already painted by the same run (idempotent poll)", async () => {
      const times = hoursFrom(
        RUN,
        Array.from({ length: 15 }, (_, i) => i),
      );
      mockRepo.findFrames.mockResolvedValue(
        times.flatMap((t) =>
          ["wind", "temperature", "precipitation", "snowfall"].map((layer) =>
            frame("dwd_icon_d2", layer, t),
          ),
        ),
      );

      const summary = await service.refresh(NOW, D2);

      expect(summary.rendered).toBe(0);
      expect(summary.upToDate).toBe(1);
      expect(mockSource.fetchGrids).not.toHaveBeenCalled();
      expect(mockStorage.put).not.toHaveBeenCalled();
    });

    it("repaints only the layers whose run is older", async () => {
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [NOON] }));
      mockRepo.findFrames.mockResolvedValue([
        frame("dwd_icon_d2", "wind", NOON, { runTime: OLDER_RUN }),
        frame("dwd_icon_d2", "temperature", NOON), // current run — skip
        frame("dwd_icon_d2", "precipitation", NOON, { runTime: OLDER_RUN }),
        frame("dwd_icon_d2", "snowfall", NOON),
      ]);

      const summary = await service.refresh(NOW, D2);

      expect(summary.rendered).toBe(2);
      const keys = mockStorage.put.mock.calls.map(([key]) => key);
      expect(keys).toEqual([
        "weather-map/dwd_icon_d2/wind/2026-07-15T1200Z.webp",
        "weather-map/dwd_icon_d2/precipitation/2026-07-15T1200Z.webp",
      ]);
      // The union read only covers the due layers' variables.
      const requested = mockSource.fetchGrids.mock.calls[0][3];
      expect(requested).not.toContain("temperature_2m");
      expect(requested).not.toContain("snowfall");
    });

    it("skips a layer whose variable the file lacks (snowfall in summer)", async () => {
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [NOON] }));
      const grids = allGrids();
      grids.delete("snowfall");
      mockSource.fetchGrids.mockResolvedValue(grids);

      const summary = await service.refresh(NOW, D2);

      expect(summary.rendered).toBe(3);
      expect(summary.missingVariable).toBe(1);
      // The explicit per-layer view: WHAT is missing, right in the output.
      expect(summary.missingByLayer).toEqual({ snowfall: 1 });
      expect(summary.errors).toEqual([]);
      // The pivot's raw data: snowfall is marked missing, the rest rendered.
      expect(summary.layerStats).toEqual(
        expect.arrayContaining([
          {
            model: "dwd_icon_d2",
            layer: "snowfall",
            rendered: 0,
            missingVariable: 1,
          },
          {
            model: "dwd_icon_d2",
            layer: "wind",
            rendered: 1,
            missingVariable: 0,
          },
        ]),
      );
      const keys = mockStorage.put.mock.calls.map(([key]) => key);
      expect(keys).not.toContain(
        "weather-map/dwd_icon_d2/snowfall/2026-07-15T1200Z.webp",
      );
    });

    it("skips a run that is still uploading (completed: false)", async () => {
      mockSource.fetchLatest.mockResolvedValue(latest({ completed: false }));

      const summary = await service.refresh(NOW, D2);

      expect(summary.rendered).toBe(0);
      expect(mockSource.fetchGrids).not.toHaveBeenCalled();
    });

    it("lets refresh overrides narrow models/layers/horizon (force-run)", async () => {
      // Config allows one model + all layers; the override renders a specific
      // slice with a longer horizon instead.
      mockSource.fetchLatest.mockResolvedValue(
        latest({
          validTimes: [NOON, new Date("2026-07-16T02:00:00Z")], // T+16h
        }),
      );

      const summary = await service.refresh(NOW, {
        models: ["dwd_icon_d2"],
        layers: ["wind"],
        horizonHours: 24,
      });

      // Both valid times render (24 h horizon), wind only.
      expect(summary.rendered).toBe(2);
      expect(mockSource.fetchGrids.mock.calls[0][3]).toEqual([
        "wind_u_component_10m",
        "wind_v_component_10m",
        "wind_gusts_10m",
        "wind_speed_10m",
        "wind_direction_10m",
      ]);
    });

    it("derives u/v from speed+direction when a model lacks components", async () => {
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [NOON] }));
      // Uniform 10 m/s wind FROM the east (90°) → u = -10, v ≈ 0.
      mockSource.fetchGrids.mockResolvedValue(
        new Map([
          ["wind_speed_10m", spatialGrid([10, 10, 10, 10])],
          ["wind_direction_10m", spatialGrid([90, 90, 90, 90])],
        ]),
      );

      const summary = await service.refresh(NOW, {
        models: ["dwd_icon_d2"],
        layers: ["wind"],
      });

      expect(summary.rendered).toBe(1);
      expect(summary.missingVariable).toBe(0);
      const upsert = mockRepo.upsertFrame.mock.calls[0][0];
      const scales = upsert.scales as { uMax: number; hasRealGust: boolean };
      expect(scales.uMax).toBeCloseTo(10, 3); // |u| = speed
      expect(scales.hasRealGust).toBe(false); // no gust field either
    });

    // 20 s budget: builds the real 1.1M-cell LAEA index map and encodes a
    // real 1324×836 WebP — borderline against jest's 5 s default.
    it("reprojects LAEA models and stamps frames with the target grid + bbox", async () => {
      // UKV's native 1042×970 LAEA raster (uniform values — geometry is
      // unit-tested in laea-regrid.spec.ts; here we assert the wiring).
      const laea = (value: number): SpatialGrid => ({
        width: 1042,
        height: 970,
        data: new Float32Array(1042 * 970).fill(value),
      });
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [NOON] }));
      mockSource.fetchGrids.mockResolvedValue(
        new Map([
          ["wind_speed_10m", laea(10)],
          ["wind_direction_10m", laea(90)],
        ]),
      );

      const summary = await service.refresh(NOW, {
        models: ["ukmo_uk_deterministic_2km"],
        layers: ["wind"],
      });

      expect(summary.rendered).toBe(1);
      const upsert = mockRepo.upsertFrame.mock.calls[0][0];
      // The INSCRIBED target raster (zero out-of-domain cells — see
      // laea-regrid.ts), never the archive envelope: envelope corners would
      // encode as fabricated calm inside a bbox the client trusts.
      expect(upsert.width).toBe(1324);
      expect(upsert.height).toBe(836);
      expect(upsert.west).toBeCloseTo(-17.24, 6);
      expect(upsert.south).toBeCloseTo(45.56, 6);
      expect(upsert.east).toBeCloseTo(9.24, 6);
      expect(upsert.north).toBeCloseTo(62.28, 6);
    }, 20_000);

    it("fails the hour when a LAEA source grid shape changes upstream", async () => {
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [NOON] }));
      // 2×2 grids ≠ the spec's 1042×970 — must not ship mis-georeferenced.
      mockSource.fetchGrids.mockResolvedValue(allGrids());

      const summary = await service.refresh(NOW, {
        models: ["ukmo_uk_deterministic_2km"],
        layers: ["wind"],
      });

      expect(summary.rendered).toBe(0);
      expect(summary.frameErrors).toBe(1);
      expect(mockRepo.upsertFrame).not.toHaveBeenCalled();
    });

    it("retries a failed hour once and renders it on the second attempt", async () => {
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [NOON] }));
      mockSource.fetchGrids
        .mockRejectedValueOnce(new Error("transient blip"))
        .mockResolvedValueOnce(allGrids());

      const summary = await service.refresh(NOW, D2);

      expect(summary.rendered).toBe(4);
      expect(summary.frameErrors).toBe(0);
      expect(summary.errors).toEqual([]);
      expect(mockSource.fetchGrids).toHaveBeenCalledTimes(2);
    });

    it("skips only the failing hour — the model's other hours still render", async () => {
      const one = new Date("2026-07-15T13:00:00Z");
      mockSource.fetchLatest.mockResolvedValue(
        latest({ validTimes: [NOON, one] }),
      );
      mockSource.fetchGrids.mockImplementation(
        async (_m: string, _r: Date, validTime: Date) => {
          if (validTime.getTime() === NOON.getTime()) {
            throw new Error("archive hiccup");
          }
          return allGrids();
        },
      );

      const summary = await service.refresh(NOW, D2);

      // NOON failed (retried, failed again) → skipped; 13:00 rendered fully.
      expect(summary.frameErrors).toBe(1);
      expect(summary.rendered).toBe(4);
      expect(summary.errors).toEqual([]); // NOT a model-level error
      const keys = mockStorage.put.mock.calls.map(([key]) => key);
      expect(keys.every((k) => String(k).includes("1300Z"))).toBe(true);
    });

    it("override narrowing cannot select a model outside the enabled registry", async () => {
      const summary = await service.refresh(NOW, {
        models: ["ncep_gfs025"], // removed from the registry — never renders
      });
      expect(summary.checked).toBe(0);
      expect(mockSource.fetchLatest).not.toHaveBeenCalled();
    });

    it("isolates a failing model so the others still render", async () => {
      mockSource.fetchLatest.mockImplementation(async (model: string) => {
        if (model === "dwd_icon_d2") throw new Error("feed broken");
        return latest({ validTimes: [NOON] });
      });

      const summary = await service.refresh(NOW, {
        models: ["dwd_icon_d2", "dwd_icon_eu"],
        layers: ["wind"],
      });

      expect(summary.errors).toEqual([
        { model: "dwd_icon_d2", message: "feed broken" },
      ]);
      expect(summary.rendered).toBe(1);
    });

    it("prunes expired frames — object first, row only when the delete succeeded", async () => {
      const oldTime = new Date("2026-07-15T02:00:00Z");
      const gone = frame("dwd_icon_d2", "wind", oldTime, { id: 7 });
      const stuck = frame("dwd_icon_d2", "temperature", oldTime, {
        id: 8,
        objectKey: "weather-map/dwd_icon_d2/temperature/stuck.png",
      });
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [] }));
      mockRepo.findOlderThan.mockResolvedValue([gone, stuck]);
      mockStorage.delete.mockImplementation(async (key: string) => {
        if (key === stuck.objectKey) throw new Error("R2 hiccup");
      });

      const summary = await service.refresh(NOW, D2);

      expect(summary.pruned).toBe(1);
      // The failed object's row survives so the next prune retries it.
      expect(mockRepo.deleteByIds).toHaveBeenCalledWith([7]);
    });
  });

  describe("planRefresh", () => {
    // The orchestrator's pass takes no narrowing — quiet the other registry
    // models per test via fetchLatest so assertions stay on dwd_icon_d2.
    const onlyD2 = (d2: SpatialLatest) => {
      mockSource.fetchLatest.mockImplementation(async (model: string) =>
        model === "dwd_icon_d2" ? d2 : latest({ completed: false }),
      );
    };

    it("lists a model with due work, its run, and the due frame count", async () => {
      onlyD2(latest({ validTimes: [NOON] }));

      const plan = await service.planRefresh(NOW);

      // 1 valid time × 4 layers due, nothing rendered/fetched — plan is cheap.
      expect(plan.due).toEqual([
        {
          model: "dwd_icon_d2",
          referenceTime: RUN.toISOString(),
          dueFrames: 4,
        },
      ]);
      expect(plan.checked).toBeGreaterThan(1); // the full enabled registry
      expect(plan.errors).toEqual([]);
      expect(mockSource.fetchGrids).not.toHaveBeenCalled();
      expect(mockStorage.put).not.toHaveBeenCalled();
    });

    it("excludes up-to-date models (frames painted by the same run)", async () => {
      onlyD2(latest({ validTimes: [NOON] }));
      mockRepo.findFrames.mockResolvedValue(
        ["wind", "temperature", "precipitation", "snowfall"].map((layer) =>
          frame("dwd_icon_d2", layer, NOON),
        ),
      );

      const plan = await service.planRefresh(NOW);

      expect(plan.due).toEqual([]);
    });

    it("includes a model whose frames a newer run must repaint", async () => {
      onlyD2(latest({ validTimes: [NOON] }));
      mockRepo.findFrames.mockResolvedValue([
        frame("dwd_icon_d2", "wind", NOON, { runTime: OLDER_RUN }),
        frame("dwd_icon_d2", "temperature", NOON),
        frame("dwd_icon_d2", "precipitation", NOON),
        frame("dwd_icon_d2", "snowfall", NOON),
      ]);

      const plan = await service.planRefresh(NOW);

      expect(plan.due).toEqual([
        {
          model: "dwd_icon_d2",
          referenceTime: RUN.toISOString(),
          dueFrames: 1,
        },
      ]);
    });

    it("collects per-model failures without failing the plan", async () => {
      mockSource.fetchLatest.mockImplementation(async (model: string) => {
        if (model === "dwd_icon_d2") throw new Error("feed broken");
        return latest({ completed: false });
      });

      const plan = await service.planRefresh(NOW);

      expect(plan.errors).toEqual([
        { model: "dwd_icon_d2", message: "feed broken" },
      ]);
      expect(plan.due).toEqual([]);
    });
  });

  describe("refreshModelById", () => {
    it("renders every due frame of the one model and never prunes", async () => {
      const one = new Date("2026-07-15T13:00:00Z");
      mockSource.fetchLatest.mockResolvedValue(
        latest({ validTimes: [NOON, one] }),
      );

      const summary = await service.refreshModelById("dwd_icon_d2", NOW);

      // 2 valid times × 4 layers; hours may render concurrently.
      expect(summary).toMatchObject({
        checked: 1,
        rendered: 8,
        upToDate: 0,
        missingVariable: 0,
        pruned: 0,
        errors: [],
      });
      expect(summary.layerStats).toEqual(
        expect.arrayContaining([
          {
            model: "dwd_icon_d2",
            layer: "wind",
            rendered: 2,
            missingVariable: 0,
          },
        ]),
      );
      const keys = mockStorage.put.mock.calls.map(([key]) => key);
      expect(keys).toContain(
        "weather-map/dwd_icon_d2/wind/2026-07-15T1200Z.webp",
      );
      expect(keys).toContain(
        "weather-map/dwd_icon_d2/wind/2026-07-15T1300Z.webp",
      );
      // Pruning is the orchestrator's job — the child must not touch it.
      expect(mockRepo.findOlderThan).not.toHaveBeenCalled();
      expect(mockRepo.deleteByIds).not.toHaveBeenCalled();
      // The fan-out child measured the hour and chose a concurrency (tiny
      // test grids → the cap).
      expect(summary.profile.hourGridBytes).toBeGreaterThan(0);
      expect(summary.profile.hourConcurrency).toBe(4);
    });

    it("falls back to the concurrency cap when the FIRST hour fails unmeasured", async () => {
      const one = new Date("2026-07-15T13:00:00Z");
      const two = new Date("2026-07-15T14:00:00Z");
      mockSource.fetchLatest.mockResolvedValue(
        latest({ validTimes: [NOON, one, two] }),
      );
      // First hour renders ALONE and exhausts its retry (2 rejections) —
      // no measurement happens, so the remaining hours get the full cap.
      mockSource.fetchGrids
        .mockRejectedValueOnce(new Error("archive blip"))
        .mockRejectedValueOnce(new Error("archive blip"));

      const summary = await service.refreshModelById("dwd_icon_d2", NOW);

      expect(summary.frameErrors).toBe(1);
      expect(summary.rendered).toBe(8); // the 2 surviving hours × 4 layers
      expect(summary.profile.hourConcurrency).toBe(4); // unmeasured → cap
    });

    it("reports up-to-date when the run already painted everything", async () => {
      mockSource.fetchLatest.mockResolvedValue(latest({ validTimes: [NOON] }));
      mockRepo.findFrames.mockResolvedValue(
        ["wind", "temperature", "precipitation", "snowfall"].map((layer) =>
          frame("dwd_icon_d2", layer, NOON),
        ),
      );

      const summary = await service.refreshModelById("dwd_icon_d2", NOW);

      expect(summary).toMatchObject({ rendered: 0, upToDate: 1 });
      expect(mockSource.fetchGrids).not.toHaveBeenCalled();
    });

    it("rejects models outside the enabled registry (no isolation here — the task retries)", async () => {
      await expect(service.refreshModelById("nope", NOW)).rejects.toThrow(
        GenericError,
      );
      await expect(
        service.refreshModelById("ncep_gfs025", NOW),
      ).rejects.toThrow(GenericError);
      expect(mockSource.fetchLatest).not.toHaveBeenCalled();
    });

    it("propagates a model failure instead of swallowing it", async () => {
      mockSource.fetchLatest.mockRejectedValue(new Error("feed broken"));

      await expect(
        service.refreshModelById("dwd_icon_d2", NOW),
      ).rejects.toThrow("feed broken");
    });
  });

  describe("getCatalog", () => {
    it("lists active models and layers with units", async () => {
      const catalog = await service.getCatalog();
      // The full enabled registry — disabled entries stay out.
      const ids = catalog.models.map((m) => m.model);
      expect(ids).toContain("dwd_icon_d2");
      expect(ids).toContain("ukmo_global_deterministic_10km");
      expect(ids).toContain("ukmo_uk_deterministic_2km");
      expect(catalog.layers).toEqual([
        { layer: "wind", label: "Wind", unit: "m/s" },
        { layer: "temperature", label: "Temperature", unit: "°C" },
        { layer: "precipitation", label: "Precipitation", unit: "mm" },
        { layer: "snowfall", label: "Snowfall", unit: "cm" },
      ]);
    });

    it("derives per-model layer availability + coverage from fresh frames", async () => {
      const one = new Date("2026-07-15T13:00:00Z");
      mockRepo.findFreshFrames.mockResolvedValue([
        frame("dwd_icon_d2", "wind", NOON, { runTime: OLDER_RUN }),
        frame("dwd_icon_d2", "temperature", NOON, { runTime: OLDER_RUN }),
        frame("dwd_icon_d2", "wind", one), // newest run carries the bbox
      ]);

      const catalog = await service.getCatalog();

      const d2 = catalog.models.find((m) => m.model === "dwd_icon_d2");
      expect(d2).toMatchObject({
        layers: ["temperature", "wind"], // snowfall/precip: no frames → absent
        coverage: BBOX,
        run: RUN.toISOString(),
        validThrough: one.toISOString(),
      });
      // Models with no frames report honestly empty availability.
      const icon = catalog.models.find((m) => m.model === "dwd_icon");
      expect(icon).toMatchObject({ layers: [], coverage: null, run: null });
    });

    it("returns empty availability before anything rendered", async () => {
      const catalog = await service.getCatalog();
      expect(catalog.models[0]).toMatchObject({
        layers: [],
        coverage: null,
        run: null,
        validThrough: null,
      });
    });
  });

  describe("adaptiveHourConcurrency", () => {
    const MB = 1024 * 1024;

    it("keeps the cap for light regional hours (MET Nordic ≈ 100 MB)", () => {
      expect(adaptiveHourConcurrency(100 * MB, 4)).toBe(4);
    });

    it("drops for grid-heavy hours (ECMWF IFS ≈ 300 MiB with regrid copies)", () => {
      expect(adaptiveHourConcurrency(300 * MB, 4)).toBe(3);
    });

    it("drops harder as the hour grows (≈ 450 MiB → 2)", () => {
      expect(adaptiveHourConcurrency(450 * MB, 4)).toBe(2);
    });

    it("never goes below one, however heavy the hour", () => {
      expect(adaptiveHourConcurrency(1500 * MB, 4)).toBe(1);
    });

    it("falls back to the cap when the first hour never measured", () => {
      expect(adaptiveHourConcurrency(0, 4)).toBe(4);
    });

    it("respects a lower caller cap (the in-process refresh path uses 1)", () => {
      expect(adaptiveHourConcurrency(100 * MB, 1)).toBe(1);
    });
  });

  describe("getManifest", () => {
    it("returns one layer's frames with proxy URLs and the newest run", async () => {
      const one = new Date("2026-07-15T13:00:00Z");
      mockRepo.findFrames.mockResolvedValue([
        frame("dwd_icon_d2", "temperature", NOON, {
          runTime: OLDER_RUN,
          scales: { min: 10, max: 40 },
        }),
        frame("dwd_icon_d2", "temperature", one, {
          scales: { min: 12, max: 38 },
        }),
      ]);

      const manifest = await service.getManifest("dwd_icon_d2", "temperature");

      expect(mockRepo.findFrames).toHaveBeenCalledWith(
        "dwd_icon_d2",
        expect.any(Date),
        "temperature",
      );
      expect(manifest.model).toBe("dwd_icon_d2");
      expect(manifest.layer).toBe("temperature");
      expect(manifest.unit).toBe("°C");
      expect(manifest.run).toBe(RUN.toISOString());
      // `?v=<run epoch s>` busts caches when a newer run repaints the key.
      expect(manifest.frames[0]).toMatchObject({
        validTime: NOON.toISOString(),
        url: `/v1/weather-map/frames/dwd_icon_d2/temperature/2026-07-15T1200Z.webp?v=${Math.floor(OLDER_RUN.getTime() / 1000)}`,
        bbox: BBOX,
        scales: { min: 10, max: 40 },
      });
    });

    it("links the public bucket URL when configured", async () => {
      setConfig("https://cdn.nortada.app/");
      service = new WeatherMapService(mockRepo, mockSource, mockStorage);
      mockRepo.findFrames.mockResolvedValue([
        frame("dwd_icon_d2", "wind", NOON),
      ]);

      const manifest = await service.getManifest("dwd_icon_d2", "wind");

      expect(manifest.frames[0].url).toBe(
        `https://cdn.nortada.app/weather-map/dwd_icon_d2/wind/2026-07-15T1200Z.webp?v=${Math.floor(RUN.getTime() / 1000)}`,
      );
    });

    it("rejects unknown or inactive models and layers", async () => {
      await expect(service.getManifest("ncep_gfs025", "wind")).rejects.toThrow(
        GenericError,
      );
      await expect(service.getManifest("nope", "wind")).rejects.toThrow(
        GenericError,
      );
      await expect(
        service.getManifest("dwd_icon_d2", "cloud_cover"),
      ).rejects.toThrow(GenericError);
    });
  });

  describe("getFrameObject", () => {
    it("streams the stored object for a known frame", async () => {
      mockRepo.findFrame.mockResolvedValue(frame("dwd_icon_d2", "wind", NOON));
      mockStorage.get.mockResolvedValue(Buffer.from("png-bytes"));

      const result = await service.getFrameObject(
        "dwd_icon_d2",
        "wind",
        "2026-07-15T1200Z.webp",
      );

      expect(mockRepo.findFrame).toHaveBeenCalledWith(
        "dwd_icon_d2",
        "wind",
        NOON,
      );
      expect(mockStorage.get).toHaveBeenCalledWith(
        "weather-map/dwd_icon_d2/wind/2026-07-15T1200Z.webp",
      );
      expect(result.body.toString()).toBe("png-bytes");
      expect(result.contentType).toBe("image/webp");
    });

    it("404s for an unknown frame or unparsable file name", async () => {
      mockRepo.findFrame.mockResolvedValue(undefined);
      await expect(
        service.getFrameObject("dwd_icon_d2", "wind", "2026-07-15T1200Z.webp"),
      ).rejects.toThrow(GenericError);
      await expect(
        service.getFrameObject("dwd_icon_d2", "wind", "not-a-frame.png"),
      ).rejects.toThrow(GenericError);
      expect(mockStorage.get).not.toHaveBeenCalled();
    });
  });

  describe("frame naming", () => {
    it("round-trips valid time ↔ file name", () => {
      expect(frameFileName(NOON)).toBe("2026-07-15T1200Z.webp");
      expect(parseFrameFile("2026-07-15T1200Z.webp")).toEqual(NOON);
      // Container-transition compat: pre-switch manifests still emit .png.
      expect(parseFrameFile("2026-07-15T1200Z.png")).toEqual(NOON);
      expect(parseFrameFile("garbage.png")).toBeNull();
    });
  });
});
