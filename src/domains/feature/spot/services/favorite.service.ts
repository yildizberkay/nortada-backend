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
    // Favoritable: published spots, or the user's OWN private spot
    // (RFC-0012 — favoriting is one of the two gestures that make a
    // private spot matter). Pending/rejected must not leak into the list
    // or the weather hot-set (D-004).
    const spot = await this.resolveSpot(spotUid, user, true);
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
    // Unfavoriting allows any status — a spot that was later unpublished must
    // still be removable so the user isn't stranded with a dead favorite.
    const spot = await this.resolveSpot(spotUid, user, false);
    const removed = await this.favoriteRepository.remove(user.id, spot.id);
    if (!removed) {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.FAVORITE_NOT_FOUND,
        message: "Favorite not found",
      });
    }
  }

  private async resolveSpot(
    spotUid: string,
    user: RequestUser,
    requireFavoritable: boolean,
  ) {
    const spot = await this.spotRepository.findByUid(spotUid);
    const favoritable =
      spot?.status === "published" ||
      (spot?.status === "private" && spot.createdBy === user.id);
    if (!spot || (requireFavoritable && !favoritable)) {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.NOT_FOUND,
        message: "Spot not found",
      });
    }
    return spot;
  }
}
