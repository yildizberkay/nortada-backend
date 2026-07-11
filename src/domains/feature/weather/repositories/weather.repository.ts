import { and, eq } from "drizzle-orm";

import type {
  DBManager,
  NewWeatherCache,
  NewWeatherModelMeta,
  WeatherCache,
  WeatherModelMeta,
} from "@/db";
import { weatherCacheTable, weatherModelMetaTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

type WeatherKind = WeatherCache["kind"];

const weatherCacheColumns = {
  id: true,
  uid: true,
  spotUid: true,
  kind: true,
  fetchedAt: true,
  modelRun: true,
  payload: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const weatherModelMetaColumns = {
  id: true,
  uid: true,
  model: true,
  lastRunAvailabilityTime: true,
  updateIntervalSec: true,
  fetchedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class WeatherRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  async findCache(
    spotUid: string,
    kind: WeatherKind,
  ): Promise<WeatherCache | undefined> {
    return this.dbClient.query.weatherCache.findFirst({
      columns: weatherCacheColumns,
      where: and(
        eq(weatherCacheTable.spotUid, spotUid),
        eq(weatherCacheTable.kind, kind),
      ),
    });
  }

  async upsertCache(values: NewWeatherCache): Promise<void> {
    const { spotUid, kind, ...rest } = values;
    await this.dbClient
      .insert(weatherCacheTable)
      .values(values)
      .onConflictDoUpdate({
        target: [weatherCacheTable.spotUid, weatherCacheTable.kind],
        set: { ...rest, updatedAt: new Date() },
      });
  }

  async findModelMeta(model: string): Promise<WeatherModelMeta | undefined> {
    return this.dbClient.query.weatherModelMeta.findFirst({
      columns: weatherModelMetaColumns,
      where: eq(weatherModelMetaTable.model, model),
    });
  }

  async upsertModelMeta(values: NewWeatherModelMeta): Promise<void> {
    const { model, ...rest } = values;
    await this.dbClient
      .insert(weatherModelMetaTable)
      .values(values)
      .onConflictDoUpdate({
        target: weatherModelMetaTable.model,
        set: { ...rest, updatedAt: new Date() },
      });
  }
}
