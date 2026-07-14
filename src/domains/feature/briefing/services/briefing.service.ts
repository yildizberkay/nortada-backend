import type { Spot } from "@/db";
import type { NearbyQuery } from "@/domains/feature/spot/schemas";
import type { SpotResponse } from "@/domains/feature/spot/services/spot.service";
import {
  type DecisionReason,
  decisionReasons,
  idealBandMidMs,
} from "@/domains/feature/weather/decision";
import type { WeatherQuery } from "@/domains/feature/weather/schemas";
import { BaseUseCase } from "@/domains/platform/foundation";
import { haversineKm } from "@/packages/geo";
import { createLogger } from "@/packages/logger";

import type { BriefingQuery, briefingStates } from "../schemas";

type Sport = Spot["supportedSports"][number];
type BriefingState = (typeof briefingStates)[number];

// The conditions slice as served by WeatherService.getConditions — the port is
// structural so the briefing never depends on the weather service class.
export interface BriefingConditions {
  spotUid: string;
  sport: Sport;
  utcOffsetSeconds: number;
  current: {
    time: string;
    windSpeedMs: number;
    windGustsMs: number;
    windDirectionDeg: number;
    weatherCode: number;
    temperatureC: number;
    windSide: string | null;
  };
  decision: "go" | "watch" | "skip";
  confidence: "low" | "medium" | "high";
  bestWindow: { start: string; end: string; peakWindMs: number } | null;
  sea: {
    waveHeightM: number | null;
    seaSurfaceTemperatureC: number | null;
  } | null;
  freshness: { fetchedAt: string; modelRun: string | null; stale: boolean };
}

// Minimal slices of the other domains (ISP — the WeatherSpotPort precedent).
// Satisfied at the composition root by FavoriteService / SpotService /
// UserProfileService / WeatherService.
export interface BriefingFavoritePort {
  list(user: BriefingUser): Promise<SpotResponse[]>;
}
export interface BriefingSpotPort {
  nearby(
    query: NearbyQuery,
  ): Promise<Array<SpotResponse & { distanceKm: number }>>;
}
export interface BriefingProfilePort {
  getProfile(user: BriefingUser): Promise<{ primarySport: Sport }>;
}
export interface BriefingWeatherPort {
  getConditions(
    spotUid: string,
    query: WeatherQuery,
  ): Promise<BriefingConditions>;
}

// The user shape every port method actually needs (RequestUser satisfies it).
export interface BriefingUser {
  id: number;
}

const NEARBY_FALLBACK_RADIUS_KM = 50;
const NEARBY_FALLBACK_LIMIT = 5;
const MAX_ALTERNATIVES = 3;
const MAX_REASONS = 4; // the Today screen shows four "why" rows
const CONDITIONS_CONCURRENCY = 6; // RFC-0005 batch discipline

const log = createLogger("BriefingService");

interface BriefingSpot {
  uid: string;
  name: string;
  locality: string | null;
  region: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  waterType: Spot["waterType"];
  supportedSports: Spot["supportedSports"];
  shoreBearingDeg: number | null;
  goodWindDirections: string[] | null;
  riskyWindDirections: string[] | null;
  distanceKm: number | null;
}

interface Candidate {
  spot: BriefingSpot;
  conditions: BriefingConditions;
}

const DECISION_RANK = { go: 0, watch: 1, skip: 2 } as const;
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;
const SAFETY_REASONS: ReadonlySet<DecisionReason> = new Set([
  "offshore_risk",
  "cross_offshore_caution",
  "gusts_overpowering",
  "storm_risk",
]);

export class BriefingService extends BaseUseCase {
  constructor(
    private readonly favoritePort: BriefingFavoritePort,
    private readonly spotPort: BriefingSpotPort,
    private readonly profilePort: BriefingProfilePort,
    private readonly weatherPort: BriefingWeatherPort,
  ) {
    super();
  }

  async getBriefing(user: BriefingUser, query: BriefingQuery) {
    const sport =
      query.sport ?? (await this.profilePort.getProfile(user)).primarySport;

    const spots = await this.listCandidateSpots(user, query, sport);
    const candidates = await this.withConditions(spots, sport);
    this.rank(candidates, sport);

    const [best, ...rest] = candidates;
    const pick = best ? { ...best, reasons: this.reasons(best) } : null;

    return {
      state: this.state(pick),
      sport,
      pick,
      alternatives: rest.slice(0, MAX_ALTERNATIVES),
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Favorites are the briefing's candidate set; a user with none (and a
   * location) gets the nearest published spots so Today still answers. */
  private async listCandidateSpots(
    user: BriefingUser,
    query: BriefingQuery,
    sport: Sport,
  ): Promise<BriefingSpot[]> {
    const favorites = await this.favoritePort.list(user);
    let spots: BriefingSpot[];
    if (favorites.length > 0) {
      spots = favorites.map((spot) => this.toBriefingSpot(spot, query));
    } else if (query.lat != null && query.lon != null) {
      const nearby = await this.spotPort.nearby({
        lat: query.lat,
        lon: query.lon,
        radiusKm: NEARBY_FALLBACK_RADIUS_KM,
        limit: NEARBY_FALLBACK_LIMIT,
      });
      spots = nearby.map((spot) => this.toBriefingSpot(spot, query));
    } else {
      spots = [];
    }
    // MVP: a candidate must support the briefed sport (RFC-0010 §7; per-spot
    // sport fallback is a fast-follow).
    return spots.filter((spot) => spot.supportedSports.includes(sport));
  }

  /** Conditions per candidate — chunked allSettled; a failed spot drops out,
   * it never fails the briefing. */
  private async withConditions(
    spots: BriefingSpot[],
    sport: Sport,
  ): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (let i = 0; i < spots.length; i += CONDITIONS_CONCURRENCY) {
      const chunk = spots.slice(i, i + CONDITIONS_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((spot) =>
          this.weatherPort.getConditions(spot.uid, { sport }),
        ),
      );
      for (const [j, result] of results.entries()) {
        if (result.status === "fulfilled") {
          candidates.push({ spot: chunk[j], conditions: result.value });
        } else {
          log.warn("Briefing candidate dropped (conditions failed)", {
            spotUid: chunk[j].uid,
            error: String(result.reason),
          });
        }
      }
    }
    return candidates;
  }

  /** RFC-0010 §7: decision severity → soonest best window → confidence →
   * closest to the sport's ideal wind. Deterministic; ties keep input order. */
  private rank(candidates: Candidate[], sport: Sport): void {
    const windowStart = (c: Candidate) =>
      c.conditions.bestWindow
        ? Date.parse(c.conditions.bestWindow.start)
        : Number.POSITIVE_INFINITY;
    const bandDistance = (c: Candidate) =>
      Math.abs(c.conditions.current.windSpeedMs - idealBandMidMs(sport));

    candidates.sort(
      (a, b) =>
        DECISION_RANK[a.conditions.decision] -
          DECISION_RANK[b.conditions.decision] ||
        windowStart(a) - windowStart(b) ||
        CONFIDENCE_RANK[a.conditions.confidence] -
          CONFIDENCE_RANK[b.conditions.confidence] ||
        bandDistance(a) - bandDistance(b),
    );
  }

  /** The engine's structural "why" for the pick + a freshness note, capped to
   * what the screen shows. */
  private reasons(
    candidate: Candidate,
  ): (DecisionReason | "stale_data" | "fresh_data")[] {
    const { conditions, spot } = candidate;
    const reasons: (DecisionReason | "stale_data" | "fresh_data")[] =
      decisionReasons({
        sport: conditions.sport,
        windMs: conditions.current.windSpeedMs,
        gustMs: conditions.current.windGustsMs,
        weatherCode: conditions.current.weatherCode,
        windDirectionDeg: conditions.current.windDirectionDeg,
        shoreBearingDeg: spot.shoreBearingDeg,
      });
    reasons.push(conditions.freshness.stale ? "stale_data" : "fresh_data");
    return reasons.slice(0, MAX_REASONS);
  }

  /** RFC-0010 §4 state machine — first match wins, stale dominates. */
  private state(
    pick: (Candidate & { reasons: (DecisionReason | string)[] }) | null,
  ): BriefingState {
    if (!pick) return "noSpots";
    const c = pick.conditions;
    if (c.freshness.stale) return "stale";
    if (c.confidence === "low") return "lowConfidence";
    if (c.decision === "go") return "goodNow";
    if (c.bestWindow) return "goodLater";
    if (
      c.decision === "watch" &&
      pick.reasons.some((reason) =>
        SAFETY_REASONS.has(reason as DecisionReason),
      )
    ) {
      return "risky";
    }
    return "noGoodWindow";
  }

  private toBriefingSpot(
    spot: SpotResponse & { distanceKm?: number },
    query: BriefingQuery,
  ): BriefingSpot {
    return {
      uid: spot.uid,
      name: spot.name,
      locality: spot.locality,
      region: spot.region,
      country: spot.country,
      latitude: spot.latitude,
      longitude: spot.longitude,
      waterType: spot.waterType,
      supportedSports: spot.supportedSports,
      shoreBearingDeg: spot.shoreBearingDeg,
      goodWindDirections: spot.goodWindDirections,
      riskyWindDirections: spot.riskyWindDirections,
      distanceKm:
        spot.distanceKm ??
        (query.lat != null && query.lon != null
          ? haversineKm(query.lat, query.lon, spot.latitude, spot.longitude)
          : null),
    };
  }
}
