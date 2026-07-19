import type { Spot } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import type { RequestUser } from "@/types";

import { SpotReason } from "../errors";
import type { FavoriteRepository } from "../repositories/favorite.repository";
import type {
  SpotRepository,
  SpotWithDistance,
} from "../repositories/spot.repository";
import type {
  CreatePrivateSpotInput,
  ModerateSpotInput,
  NearbyQuery,
  SearchQuery,
  SuggestSpotInput,
} from "../schemas";
import { triggerSpotOsmIngest } from "../tasks/spot-osm-ingest.trigger";
import type { SpotGeo } from "../types";

export interface SpotResponse {
  uid: string;
  name: string;
  country: string | null;
  region: string | null;
  locality: string | null;
  latitude: number;
  longitude: number;
  waterType: Spot["waterType"];
  supportedSports: Spot["supportedSports"];
  skillSuitability: Spot["skillSuitability"];
  shoreBearingDeg: number | null;
  goodWindDirections: Spot["goodWindDirections"];
  riskyWindDirections: Spot["riskyWindDirections"];
  hazards: string[] | null;
  status: Spot["status"];
}

export const toSpotResponse = (spot: Spot): SpotResponse => ({
  uid: spot.uid,
  name: spot.name,
  country: spot.country,
  region: spot.region,
  locality: spot.locality,
  latitude: spot.latitude,
  longitude: spot.longitude,
  waterType: spot.waterType,
  supportedSports: spot.supportedSports,
  skillSuitability: spot.skillSuitability,
  shoreBearingDeg: spot.shoreBearingDeg,
  goodWindDirections: spot.goodWindDirections,
  riskyWindDirections: spot.riskyWindDirections,
  hazards: spot.hazards,
  status: spot.status,
});

export class SpotService extends BaseUseCase {
  /** Generous fixed cap (RFC-0012) — an abuse/cost guard, not a product
   * meter; nobody curates 50 secret coves. */
  private static readonly PRIVATE_SPOT_CAP = 50;

  constructor(
    private readonly spotRepository: SpotRepository,
    private readonly favoriteRepository: FavoriteRepository,
  ) {
    super();
  }

  /** Spot geo for the weather domain: published, or private (RFC-0012 —
   * the port carries no user context; the unguessable uuid IS the owner's
   * capability, and the geo/conditions of a coordinate are not a secret the
   * way the private spot's existence in lists would be). */
  async getGeoByUid(uid: string): Promise<SpotGeo> {
    const spot = await this.spotRepository.findByUid(uid);
    if (spot?.status !== "published" && spot?.status !== "private") {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.NOT_FOUND,
        message: "Spot not found",
      });
    }
    return {
      uid: spot.uid,
      latitude: spot.latitude,
      longitude: spot.longitude,
      shoreBearingDeg: spot.shoreBearingDeg,
      supportedSports: spot.supportedSports,
    };
  }

  /** The weather hot set (D-004): distinct favorited spots — published,
   * plus favorited private rows (RFC-0012). */
  async listHotSpotGeos(): Promise<SpotGeo[]> {
    return this.favoriteRepository.listDistinctFavoritedSpotGeos();
  }

  async nearby(
    query: NearbyQuery,
    user?: RequestUser,
  ): Promise<Array<SpotResponse & { distanceKm: number }>> {
    const rows = await this.spotRepository.findNearby({
      ...query,
      visibleToUserId: user?.id,
    });
    return rows.map((row: SpotWithDistance) => ({
      ...toSpotResponse(row),
      distanceKm: row.distanceKm,
    }));
  }

  async search(
    query: SearchQuery,
    user?: RequestUser,
  ): Promise<SpotResponse[]> {
    const rows = await this.spotRepository.searchByName(
      query.q,
      query.limit,
      query.sport,
      user?.id,
    );
    return rows.map(toSpotResponse);
  }

  /** Detail — published spots, plus the requester's own private spots
   * (RFC-0012); pending/rejected and other users' private rows stay hidden. */
  async detail(uid: string, user?: RequestUser): Promise<SpotResponse> {
    const spot = await this.spotRepository.findByUid(uid);
    const visible =
      spot?.status === "published" ||
      (spot?.status === "private" && spot.createdBy === user?.id);
    if (!spot || !visible) {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.NOT_FOUND,
        message: "Spot not found",
      });
    }
    return toSpotResponse(spot);
  }

  /** RFC-0012 private spot — save-on-intent: created the moment the user
   * sets an alert on / favorites a virtual point, never by browsing. Owned
   * by its creator, visible only to them, never moderated or published.
   * The stored coordinate is the user's EXACT tap, not the grid key. */
  async createPrivate(
    user: RequestUser,
    input: CreatePrivateSpotInput,
  ): Promise<SpotResponse> {
    const owned = await this.spotRepository.countPrivateByOwner(user.id);
    if (owned >= SpotService.PRIVATE_SPOT_CAP) {
      // CONFLICT, not FORM_ERROR: the payload is fine — the ACCOUNT is full.
      throw new GenericError("CONFLICT", {
        reason: SpotReason.PRIVATE_SPOT_LIMIT,
        message: `Private spot limit reached (${SpotService.PRIVATE_SPOT_CAP})`,
      });
    }
    const spot = await this.spotRepository.create({
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      supportedSports: [input.sport],
      source: "user_private",
      status: "private",
      createdBy: user.id,
    });
    return toSpotResponse(spot);
  }

  /** A user-suggested spot — lands pending for admin moderation. */
  async suggest(
    user: RequestUser,
    input: SuggestSpotInput,
  ): Promise<SpotResponse> {
    const spot = await this.spotRepository.create({
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      country: input.country ?? null,
      region: input.region ?? null,
      locality: input.locality ?? null,
      waterType: input.waterType ?? null,
      supportedSports: input.supportedSports,
      // The suggester's local knowledge lands on the curated columns —
      // moderation refines them before publishing.
      goodWindDirections: input.goodWindDirections ?? null,
      riskyWindDirections: input.riskyWindDirections ?? null,
      suggestionNotes: input.notes ?? null,
      source: "user_suggested",
      status: "pending",
      createdBy: user.id,
    });
    return toSpotResponse(spot);
  }

  /** Moderation queue rows — the one response carrying `suggestionNotes`. */
  async listByStatus(
    status: Spot["status"],
    limit: number,
  ): Promise<Array<SpotResponse & { suggestionNotes: string | null }>> {
    const rows = await this.spotRepository.listByStatus(status, limit);
    return rows.map((row) => ({
      ...toSpotResponse(row),
      suggestionNotes: row.suggestionNotes,
    }));
  }

  /** Admin: enqueue an OSM ingest for a country → returns the Trigger run id. */
  async requestOsmIngest(isoCountryCode: string): Promise<{ taskId: string }> {
    const taskId = await triggerSpotOsmIngest(isoCountryCode);
    return { taskId };
  }

  /** Admin moderation — publish/reject + curate spot intelligence. Private
   * rows are untouchable (RFC-0012): the schema already refuses `private`
   * as a status VALUE; this guards the private row as a TARGET. */
  async moderate(uid: string, input: ModerateSpotInput): Promise<SpotResponse> {
    const existing = await this.spotRepository.findByUid(uid);
    if (!existing) {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.NOT_FOUND,
        message: "Spot not found",
      });
    }
    if (existing.status === "private") {
      throw new GenericError("FORBIDDEN", {
        reason: SpotReason.NOT_FOUND,
        message: "Private spots are never moderated",
      });
    }
    const updated = await this.spotRepository.updateByUid(uid, input);
    if (!updated) {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.NOT_FOUND,
        message: "Spot not found",
      });
    }
    return toSpotResponse(updated);
  }
}
