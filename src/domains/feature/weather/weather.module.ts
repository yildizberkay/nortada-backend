import type { ModuleDeps } from "@/container";
import { OpenMeteoClient } from "@/packages/open-meteo";

import { WeatherRepository } from "./repositories/weather.repository";
import {
  WeatherService,
  type WeatherSpotPort,
} from "./services/weather.service";

export interface WeatherModuleDeps extends ModuleDeps {
  // The spot slice weather needs (SpotService satisfies it) — passed explicitly
  // at the composition root.
  spotPort: WeatherSpotPort;
}

export function createWeatherModule({ db, spotPort }: WeatherModuleDeps) {
  const weatherRepository = new WeatherRepository(db);
  const openMeteoClient = new OpenMeteoClient();
  const weatherService = new WeatherService(
    weatherRepository,
    openMeteoClient,
    spotPort,
  );
  return { weatherService };
}
