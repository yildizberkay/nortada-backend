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

export class WeatherRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  async getCache(
    spotUid: string,
    kind: WeatherKind,
  ): Promise<WeatherCache | undefined> {
    return this.dbClient.query.weatherCache.findFirst({
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

  async getModelMeta(model: string): Promise<WeatherModelMeta | undefined> {
    return this.dbClient.query.weatherModelMeta.findFirst({
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
