import type { ModuleDeps } from "@/container";
import type { SpotService } from "@/domains/feature/spot/services/spot.service";
import { OpenMeteoClient } from "@/packages/open-meteo";

import { WeatherRepository } from "./repositories/weather.repository";
import { WeatherService } from "./services/weather.service";

export interface WeatherModuleDeps extends ModuleDeps {
  // Cross-domain: weather resolves spot geo + the favorites hot set.
  spotService: SpotService;
}

export function createWeatherModule({ db, spotService }: WeatherModuleDeps) {
  const weatherRepository = new WeatherRepository(db);
  const openMeteoClient = new OpenMeteoClient();
  const weatherService = new WeatherService(
    weatherRepository,
    openMeteoClient,
    spotService,
  );
  return { weatherService };
}
