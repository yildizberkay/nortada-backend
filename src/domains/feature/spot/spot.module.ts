import type { ModuleDeps } from "@/container";
import { OverpassClient } from "@/packages/overpass";
import type { MergeReassigner } from "@/types";

import { FavoriteRepository } from "./repositories/favorite.repository";
import { SpotRepository } from "./repositories/spot.repository";
import { FavoriteService } from "./services/favorite.service";
import { SpotService } from "./services/spot.service";
import { SpotIngestService } from "./services/spot-ingest.service";

export function createSpotModule({ db }: ModuleDeps) {
  const spotRepository = new SpotRepository(db);
  const favoriteRepository = new FavoriteRepository(db);
  const overpassClient = new OverpassClient();

  const spotService = new SpotService(spotRepository, favoriteRepository);
  const favoriteService = new FavoriteService(
    favoriteRepository,
    spotRepository,
  );
  const spotIngestService = new SpotIngestService(
    overpassClient,
    spotRepository,
  );

  // Merge hook (D-008): favorites AND private spots (RFC-0012) move to the
  // target account on link — a stranded `createdBy` would hide every
  // private row from its owner forever.
  const favoriteReassigner: MergeReassigner = async (from, to, tx) => {
    await favoriteRepository.reassignOwner(from, to, tx);
    await spotRepository.reassignPrivateOwner(from, to, tx);
  };

  return {
    spotService,
    favoriteService,
    spotIngestService,
    favoriteReassigner,
  };
}
