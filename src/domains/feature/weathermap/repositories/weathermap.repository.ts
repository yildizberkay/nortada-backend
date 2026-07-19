import { and, asc, eq, gt, gte, inArray, lt } from "drizzle-orm";

import type { DBManager, NewWeatherMapFrame, WeatherMapFrame } from "@/db";
import { weatherMapFrameTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

const frameColumns = {
  id: true,
  uid: true,
  model: true,
  layer: true,
  validTime: true,
  runTime: true,
  objectKey: true,
  width: true,
  height: true,
  west: true,
  south: true,
  east: true,
  north: true,
  scales: true,
  renderedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class WeatherMapRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  /**
   * A model's frames from `since` on, ordered by valid time. With `layer` it
   * answers the manifest; without, the refresh pass reads every layer's state
   * in one query.
   */
  async findFrames(
    model: string,
    since: Date,
    layer?: string,
  ): Promise<WeatherMapFrame[]> {
    return this.dbClient.query.weatherMapFrame.findMany({
      columns: frameColumns,
      where: and(
        eq(weatherMapFrameTable.model, model),
        gte(weatherMapFrameTable.validTime, since),
        layer === undefined ? undefined : eq(weatherMapFrameTable.layer, layer),
      ),
      orderBy: asc(weatherMapFrameTable.validTime),
    });
  }

  /**
   * Slim rows of every frame fresh enough to serve — the catalog derives
   * per-model layer availability + coverage from these (the frames ARE the
   * empirical truth of what each model publishes; availability is seasonal —
   * e.g. snowfall — so it is never hardcoded).
   */
  async findFreshFrames(
    since: Date,
  ): Promise<
    Pick<
      WeatherMapFrame,
      | "model"
      | "layer"
      | "runTime"
      | "validTime"
      | "west"
      | "south"
      | "east"
      | "north"
    >[]
  > {
    return this.dbClient.query.weatherMapFrame.findMany({
      columns: {
        model: true,
        layer: true,
        runTime: true,
        validTime: true,
        west: true,
        south: true,
        east: true,
        north: true,
      },
      where: gte(weatherMapFrameTable.validTime, since),
    });
  }

  async findFrame(
    model: string,
    layer: string,
    validTime: Date,
  ): Promise<WeatherMapFrame | undefined> {
    return this.dbClient.query.weatherMapFrame.findFirst({
      columns: frameColumns,
      where: and(
        eq(weatherMapFrameTable.model, model),
        eq(weatherMapFrameTable.layer, layer),
        eq(weatherMapFrameTable.validTime, validTime),
      ),
    });
  }

  /** Insert or repaint-in-place on the (model, layer, validTime) natural key. */
  async upsertFrame(values: NewWeatherMapFrame): Promise<void> {
    const { model, layer, validTime, ...rest } = values;
    await this.dbClient
      .insert(weatherMapFrameTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          weatherMapFrameTable.model,
          weatherMapFrameTable.layer,
          weatherMapFrameTable.validTime,
        ],
        set: { ...rest, updatedAt: new Date() },
      });
  }

  /** Frames whose valid time fell behind the retention cutoff (for pruning). */
  async findOlderThan(cutoff: Date): Promise<WeatherMapFrame[]> {
    return this.dbClient.query.weatherMapFrame.findMany({
      columns: frameColumns,
      where: lt(weatherMapFrameTable.validTime, cutoff),
    });
  }

  /** Frames whose valid time lies beyond the horizon cap (for pruning). */
  async findBeyond(cutoff: Date): Promise<WeatherMapFrame[]> {
    return this.dbClient.query.weatherMapFrame.findMany({
      columns: frameColumns,
      where: gt(weatherMapFrameTable.validTime, cutoff),
    });
  }

  async deleteByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.dbClient
      .delete(weatherMapFrameTable)
      .where(inArray(weatherMapFrameTable.id, ids));
  }
}
