import type { Spot } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import { GenericError } from "@/packages/error";
import type { RequestUser } from "@/types";

import { SpotReason } from "../errors";
import type {
  SpotRepository,
  SpotWithDistance,
} from "../repositories/spot.repository";
import type {
  ModerateSpotInput,
  NearbyQuery,
  SearchQuery,
  SuggestSpotInput,
} from "../schemas";
import { triggerSpotOsmIngest } from "../tasks/spot-osm-ingest.trigger";

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
  constructor(private readonly spotRepository: SpotRepository) {
    super();
  }

  async nearby(
    query: NearbyQuery,
  ): Promise<Array<SpotResponse & { distanceKm: number }>> {
    const rows = await this.spotRepository.findNearby(query);
    return rows.map((row: SpotWithDistance) => ({
      ...toSpotResponse(row),
      distanceKm: row.distanceKm,
    }));
  }

  async search(query: SearchQuery): Promise<SpotResponse[]> {
    const rows = await this.spotRepository.searchByName(
      query.q,
      query.limit,
      query.sport,
    );
    return rows.map(toSpotResponse);
  }

  /** Public detail — published spots only (pending/rejected are hidden). */
  async detail(uid: string): Promise<SpotResponse> {
    const spot = await this.spotRepository.findByUid(uid);
    if (spot?.status !== "published") {
      throw new GenericError("NOT_FOUND", {
        reason: SpotReason.NOT_FOUND,
        message: "Spot not found",
      });
    }
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
      source: "user_suggested",
      status: "pending",
      createdBy: user.id,
    });
    return toSpotResponse(spot);
  }

  async listByStatus(
    status: Spot["status"],
    limit: number,
  ): Promise<SpotResponse[]> {
    const rows = await this.spotRepository.listByStatus(status, limit);
    return rows.map(toSpotResponse);
  }

  /** Admin: enqueue an OSM ingest for a country → returns the Trigger run id. */
  async requestOsmIngest(isoCountryCode: string): Promise<{ taskId: string }> {
    const taskId = await triggerSpotOsmIngest(isoCountryCode);
    return { taskId };
  }

  /** Admin moderation — publish/reject + curate spot intelligence. */
  async moderate(uid: string, input: ModerateSpotInput): Promise<SpotResponse> {
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
