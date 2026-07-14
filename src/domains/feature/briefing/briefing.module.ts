import type { ModuleDeps } from "@/container";

import {
  type BriefingFavoritePort,
  type BriefingProfilePort,
  BriefingService,
  type BriefingSpotPort,
  type BriefingWeatherPort,
} from "./services/briefing.service";

export interface BriefingModuleDeps extends ModuleDeps {
  // The slices briefing composes over — satisfied by FavoriteService /
  // SpotService / UserProfileService / WeatherService at the composition root.
  favoritePort: BriefingFavoritePort;
  spotPort: BriefingSpotPort;
  profilePort: BriefingProfilePort;
  weatherPort: BriefingWeatherPort;
}

export function createBriefingModule({
  favoritePort,
  spotPort,
  profilePort,
  weatherPort,
}: BriefingModuleDeps) {
  const briefingService = new BriefingService(
    favoritePort,
    spotPort,
    profilePort,
    weatherPort,
  );
  return { briefingService };
}
