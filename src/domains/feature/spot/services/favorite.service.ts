import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import type { RequestUser } from "@/types";

import { SpotReason } from "../errors";
import type { FavoriteRepository } from "../repositories/favorite.repository";
import type { SpotRepository } from "../repositories/spot.repository";
import { type SpotResponse, toSpotResponse } from "./spot.service";

export class FavoriteService extends BaseUseCase {
  constructor(
    private readonly favoriteRepository: FavoriteRepository,
    private readonly spotRepository: SpotRepository,
  ) {
    super();
  }

  async list(user: RequestUser): Promise<SpotResponse[]> {
    const spots = await this.favoriteRepository.listSpotsByUser(user.id);
    return spots.map(toSpotResponse);
  }

  async add(user: RequestUser, spotUid: string): Promise<SpotResponse> {
    const spot = await this.resolveSpot(spotUid);
    const added = await this.favoriteRepository.add(user.id, spot.id);
    if (!added) {
      throw new GenericError("ALREADY_EXISTS", {
        reason: SpotReason.ALREADY_FAVORITED,
        message: "Spot is already favorited",
      });
    }
    return toSpotResponse(spot);
  }

  async remove(user: RequestUser, spotUid: string): Promise<void> {
    const spot = await this.resolveSpot(spotUid);
    const removed = await this.favoriteRepository.remove(user.id, spot.id);
    if (!removed) {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.FAVORITE_NOT_FOUND,
        message: "Favorite not found",
      });
    }
  }

  private async resolveSpot(spotUid: string) {
    const spot = await this.spotRepository.findByUid(spotUid);
    if (!spot) {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.NOT_FOUND,
        message: "Spot not found",
      });
    }
    return spot;
  }
}
