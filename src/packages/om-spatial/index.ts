import {
  OmDataType,
  OmFileReader,
  OmHttpBackend,
} from "@openmeteo/file-reader";

import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";

const logger = createLogger("om-spatial");

// Open-Meteo spatial archive client (RFC-0011). One `.om` file per (model run,
// valid time) at `<base>/<model>/<yyyy>/<mm>/<dd>/<HHMM>Z/<valid>.om`, indexed
// by `<base>/<model>/latest.json`. Reads go through `@openmeteo/file-reader`'s
// HTTP backend, which range-requests only the requested variables' chunks —
// whole files are 8–43 MB while a handful of fields is a fraction of that.
// The client is variable-agnostic: callers name the variables they need
// (wind components, temperature, precipitation, …) and get back whichever of
// them the file actually contains.

export interface SpatialBBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SpatialLatest {
  /** False while the archive is still writing this run's files. */
  completed: boolean;
  referenceTime: Date;
  validTimes: Date[];
  bbox: SpatialBBox;
}

/**
 * One variable's raw grid for one valid time, exactly as stored in the `.om`
 * file: row-major `[height][width]`, **row 0 = southernmost latitude** (the
 * PNG encoders flip to north-origin).
 */
export interface SpatialGrid {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * Spatial-archive contract. `WeatherMapService` depends on this, not on the
 * concrete client, so tests fake it in memory.
 */
export interface SpatialSource {
  fetchLatest(model: string): Promise<SpatialLatest>;
  /**
   * Read the named variables from one (run, valid time) file over a single
   * HTTP reader. Variables the file doesn't contain are simply absent from
   * the result (e.g. `wind_gusts_10m` on analysis frames, `snowfall` in
   * models/seasons without it) — the caller decides what is a hard miss.
   */
  fetchGrids(
    model: string,
    referenceTime: Date,
    validTime: Date,
    variables: string[],
  ): Promise<Map<string, SpatialGrid>>;
}

/** Children metadata reads in flight at once (per file). */
const ENUM_CHUNK = 24;

/**
 * The library's default `OmFileReader.create` shares ONE Emscripten wasm
 * instance across every reader in the process — and its heap is FIXED-size
 * (growth disabled upstream). Under a whole-registry render the shared heap
 * first fragments (`memory access out of bounds` on later big grids) and
 * eventually aborts (`RuntimeError: Aborted(OOM)`), which poisons the
 * instance for the entire process. The fix is a FRESH wasm instance per
 * `.om` file: its heap dies with the reader, so nothing accumulates. V8
 * caches the compiled module, so per-file instantiation costs ~3 ms.
 *
 * The instance factory duplicates the library's unexported
 * `createWrappedModule` mapping (pinned `@openmeteo/file-reader@0.0.17` —
 * revisit when bumping that dependency).
 */
type WasmModule = NonNullable<ConstructorParameters<typeof OmFileReader>[1]>;

const DATA_TYPES = {
  DATA_TYPE_NONE: 0,
  DATA_TYPE_INT8: 1,
  DATA_TYPE_UINT8: 2,
  DATA_TYPE_INT16: 3,
  DATA_TYPE_UINT16: 4,
  DATA_TYPE_INT32: 5,
  DATA_TYPE_UINT32: 6,
  DATA_TYPE_INT64: 7,
  DATA_TYPE_UINT64: 8,
  DATA_TYPE_FLOAT: 9,
  DATA_TYPE_DOUBLE: 10,
  DATA_TYPE_STRING: 11,
  DATA_TYPE_INT8_ARRAY: 12,
  DATA_TYPE_UINT8_ARRAY: 13,
  DATA_TYPE_INT16_ARRAY: 14,
  DATA_TYPE_UINT16_ARRAY: 15,
  DATA_TYPE_INT32_ARRAY: 16,
  DATA_TYPE_UINT32_ARRAY: 17,
  DATA_TYPE_INT64_ARRAY: 18,
  DATA_TYPE_UINT64_ARRAY: 19,
  DATA_TYPE_FLOAT_ARRAY: 20,
  DATA_TYPE_DOUBLE_ARRAY: 21,
  DATA_TYPE_STRING_ARRAY: 22,
} as const;
const HEADER_TYPES = {
  OM_HEADER_INVALID: 0,
  OM_HEADER_LEGACY: 1,
  OM_HEADER_READ_TRAILER: 2,
} as const;

type RawWasm = Record<string, unknown>;
let wasmFactory: (() => Promise<RawWasm>) | undefined;

async function createWasmInstance(): Promise<WasmModule> {
  if (!wasmFactory) {
    const module = await import("@openmeteo/file-format-wasm");
    wasmFactory = module.default as () => Promise<RawWasm>;
  }
  const raw = await wasmFactory();
  return {
    _malloc: raw._malloc,
    _free: raw._free,
    setValue: raw.setValue,
    getValue: raw.getValue,
    get HEAPU8() {
      return raw.HEAPU8;
    },
    om_header_size: raw._om_header_size,
    om_header_type: raw._om_header_type,
    om_trailer_size: raw._om_trailer_size,
    om_trailer_read: raw._om_trailer_read,
    om_variable_init: raw._om_variable_init,
    om_variable_get_type: raw._om_variable_get_type,
    om_variable_get_compression: raw._om_variable_get_compression,
    om_variable_get_scale_factor: raw._om_variable_get_scale_factor,
    om_variable_get_add_offset: raw._om_variable_get_add_offset,
    om_variable_get_dimensions_count: raw._om_variable_get_dimensions_count,
    om_variable_get_dimensions_ptr: raw._om_variable_get_dimensions,
    om_variable_get_chunks_ptr: raw._om_variable_get_chunks,
    om_variable_get_name_ptr: raw._om_variable_get_name,
    om_variable_get_children_count: raw._om_variable_get_children_count,
    om_variable_get_children: raw._om_variable_get_children,
    om_variable_get_scalar: raw._om_variable_get_scalar,
    om_decoder_init: raw._om_decoder_init,
    om_decoder_init_index_read: raw._om_decoder_init_index_read,
    om_decoder_init_data_read: raw._om_decoder_init_data_read,
    om_decoder_read_buffer_size: raw._om_decoder_read_buffer_size,
    om_decoder_next_index_read: raw._om_decoder_next_index_read,
    om_decoder_next_data_read: raw._om_decoder_next_data_read,
    om_decoder_decode_chunks: raw._om_decoder_decode_chunks,
    ...HEADER_TYPES,
    ERROR_OK: 0,
    ...DATA_TYPES,
    sizeof_decoder: 104,
  } as unknown as WasmModule;
}

/**
 * TOTAL in-flight data decodes process-wide — each runs on its own file's
 * heap, so this bounds resident memory (concurrency × instance heap), not a
 * shared heap.
 */
const READ_CONCURRENCY = 2;

class Semaphore {
  private readonly queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const readSemaphore = new Semaphore(READ_CONCURRENCY);

/** Open-Meteo's spatial archive host — a design constant (RFC-0011), not
 * deployment config. */
const SPATIAL_BASE_URL = "https://map-tiles.open-meteo.com/data_spatial";

export class OmSpatialClient implements SpatialSource {
  private readonly baseUrl = SPATIAL_BASE_URL;

  async fetchLatest(model: string): Promise<SpatialLatest> {
    const url = `${this.baseUrl}/${model}/latest.json`;
    let raw: string;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      raw = await response.text();
    } catch (error) {
      logger.error("latest.json fetch failed", { model, error });
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: `Failed to fetch spatial index for ${model}`,
      });
    }
    return this.parseLatest(model, raw);
  }

  async fetchGrids(
    model: string,
    referenceTime: Date,
    validTime: Date,
    variables: string[],
  ): Promise<Map<string, SpatialGrid>> {
    const url = this.frameUrl(model, referenceTime, validTime);
    try {
      const backend = new OmHttpBackend({ url });
      // Fresh wasm instance per file (see createWasmInstance) — never the
      // library's shared singleton.
      const reader = new OmFileReader(backend, await createWasmInstance());
      await reader.initialize();
      const children: (OmFileReader | null)[] = [];
      try {
        // Enumerate children ONCE, in parallel — `getChildByName` scans the
        // ~126 variables' metadata sequentially over HTTP (~15 s for a name
        // near the end, and a full scan for a missing one); indexed fetches
        // land in ~0.6 s total. CHUNKED: some files have 300+ children and
        // several models refresh concurrently — unbounded fan-out here was a
        // connection storm (thousands of simultaneous range requests) that
        // showed up as transient read failures across whole models.
        const count = reader.numberOfChildren();
        for (let start = 0; start < count; start += ENUM_CHUNK) {
          const end = Math.min(start + ENUM_CHUNK, count);
          children.push(
            ...(await Promise.all(
              Array.from({ length: end - start }, (_, i) =>
                reader.getChild(start + i),
              ),
            )),
          );
        }
        const byName = new Map<string, OmFileReader>();
        for (const child of children) {
          const name = child?.getName();
          if (child && name) byName.set(name, child);
        }
        // Variables read CONCURRENTLY — each read allocates its own decoder,
        // verified to return byte-identical results in ~⅓ the wall-clock.
        const entries = await Promise.all(
          variables.map(async (name) => {
            const child = byName.get(name);
            if (!child) return null;
            return [name, await this.readVariable(child, name)] as const;
          }),
        );
        const grids = new Map<string, SpatialGrid>();
        for (const entry of entries) {
          if (entry) grids.set(entry[0], entry[1]);
        }
        return grids;
      } finally {
        for (const child of children) child?.dispose();
        reader.dispose();
      }
    } catch (error) {
      logger.error("spatial grid read failed", { model, url, error });
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: `Failed to read spatial fields for ${model}`,
      });
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * `latest.json` embeds raw newlines inside `crs_wkt` (invalid strict JSON) —
   * control characters are replaced before parsing. The grid bbox comes from
   * the WKT `BBOX[south,west,north,east]` clause.
   */
  private parseLatest(model: string, raw: string): SpatialLatest {
    let parsed: {
      completed?: boolean;
      reference_time?: string;
      valid_times?: string[];
      crs_wkt?: string;
    };
    try {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the upstream JSON embeds raw newlines in crs_wkt
      parsed = JSON.parse(raw.replace(/[\u0000-\u001f]/g, " "));
    } catch (error) {
      logger.error("latest.json parse failed", { model, error });
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: `Malformed spatial index for ${model}`,
      });
    }
    const referenceTime = parsed.reference_time
      ? new Date(parsed.reference_time)
      : undefined;
    const validTimes = (parsed.valid_times ?? []).map((t) => new Date(t));
    const bbox = this.parseBBox(parsed.crs_wkt ?? "");
    if (
      !referenceTime ||
      Number.isNaN(referenceTime.getTime()) ||
      validTimes.length === 0 ||
      validTimes.some((t) => Number.isNaN(t.getTime())) ||
      !bbox
    ) {
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: `Incomplete spatial index for ${model}`,
      });
    }
    return {
      completed: parsed.completed === true,
      referenceTime,
      validTimes,
      bbox,
    };
  }

  private parseBBox(crsWkt: string): SpatialBBox | undefined {
    const match = crsWkt.match(
      /BBOX\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/,
    );
    if (!match) return undefined;
    const [south, west, north, east] = match.slice(1).map(Number);
    if ([south, west, north, east].some(Number.isNaN)) return undefined;
    return { west, south, east, north };
  }

  private frameUrl(
    model: string,
    referenceTime: Date,
    validTime: Date,
  ): string {
    const ref = referenceTime.toISOString();
    const runPath = `${ref.slice(0, 4)}/${ref.slice(5, 7)}/${ref.slice(8, 10)}/${ref.slice(11, 13)}${ref.slice(14, 16)}Z`;
    const valid = validTime.toISOString();
    const validName = `${valid.slice(0, 13)}${valid.slice(14, 16)}`;
    return `${this.baseUrl}/${model}/${runPath}/${validName}.om`;
  }

  private async readVariable(
    child: OmFileReader,
    name: string,
  ): Promise<SpatialGrid> {
    const dims = child.getDimensions();
    if (dims.length !== 2) {
      throw new Error(`${name}: expected 2 dimensions, got ${dims.length}`);
    }
    const data = await readSemaphore.run(() =>
      child.read({
        type: OmDataType.FloatArray,
        ranges: dims.map((end) => ({ start: 0, end })),
      }),
    );
    return { width: dims[1], height: dims[0], data };
  }
}
