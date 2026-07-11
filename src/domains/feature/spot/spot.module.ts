import type { ModuleDeps } from "@/container";

import { FavoriteRepository } from "./repositories/favorite.repository";
import { SpotRepository } from "./repositories/spot.repository";
import { FavoriteService } from "./services/favorite.service";
import { SpotService } from "./services/spot.service";

export function createSpotModule({ db }: ModuleDeps) {
  const spotRepository = new SpotRepository(db);
  const favoriteRepository = new FavoriteRepository(db);
  const spotService = new SpotService(spotRepository);
  const favoriteService = new FavoriteService(
    favoriteRepository,
    spotRepository,
  );
  return { spotService, favoriteService };
}
