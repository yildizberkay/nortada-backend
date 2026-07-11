import type { ModuleDeps } from "@/container";
import { OverpassClient } from "@/packages/overpass";

import { FavoriteRepository } from "./repositories/favorite.repository";
import { SpotRepository } from "./repositories/spot.repository";
import { FavoriteService } from "./services/favorite.service";
import { SpotService } from "./services/spot.service";
import { SpotIngestService } from "./services/spot-ingest.service";

export function createSpotModule({ db }: ModuleDeps) {
  const spotRepository = new SpotRepository(db);
  const favoriteRepository = new FavoriteRepository(db);
  const overpassClient = new OverpassClient();

  const spotService = new SpotService(spotRepository);
  const favoriteService = new FavoriteService(
    favoriteRepository,
    spotRepository,
  );
  const spotIngestService = new SpotIngestService(
    overpassClient,
    spotRepository,
  );
  return { spotService, favoriteService, spotIngestService };
}
