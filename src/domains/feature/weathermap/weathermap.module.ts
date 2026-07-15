import type { ModuleDeps } from "@/container";
import { S3ObjectStorage } from "@/packages/object-storage";
import { OmSpatialClient } from "@/packages/om-spatial";

import { WeatherMapRepository } from "./repositories/weathermap.repository";
import { WeatherMapService } from "./services/weathermap.service";

export function createWeatherMapModule({ db }: ModuleDeps) {
  const weatherMapRepository = new WeatherMapRepository(db);
  // Both clients are config-free at construction (built lazily on first use),
  // matching OpenMeteoClient — buildContainer stays import-safe.
  const spatialClient = new OmSpatialClient();
  const objectStorage = new S3ObjectStorage();

  const weatherMapService = new WeatherMapService(
    weatherMapRepository,
    spatialClient,
    objectStorage,
  );
  return { weatherMapService };
}
