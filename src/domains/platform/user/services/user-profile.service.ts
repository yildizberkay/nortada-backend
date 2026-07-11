import type { JsonValue, UserProfile, UserSportProfile } from "@/db";
import { BaseUseCase } from "@/domains/platform/foundation";
import type { RequestUser } from "@/types";

import type { UserProfileRepository } from "../repositories/user-profile.repository";
import type {
  ProfileResponse,
  SportProfileResponse,
  UpdateProfileInput,
  UpsertSportProfileInput,
} from "../schemas";

type Sport = UserProfile["primarySport"];
type Goal = UserProfile["goal"];
type SummaryMetric = UserProfile["cardSlots"][number];

// The persisted value fields of a profile (response minus the derived marker).
type ProfileValues = Omit<ProfileResponse, "onboarded">;

// Canonical port of the app's `SummaryMetric.defaultSlots(sport:goal:)` — the
// four summary-card metrics a sport/goal combination opens with.
function defaultSlots(sport: Sport, goal: Goal): SummaryMetric[] {
  switch (sport) {
    case "windsurf":
      if (goal === "improve_speed" || goal === "racing") {
        return ["distance", "time_on_water", "best_5x10", "sessions"];
      }
      if (goal === "improve_technique") {
        return ["time_on_water", "moving_time", "best_5x10", "sessions"];
      }
      return ["distance", "time_on_water", "max_speed", "sessions"];
    case "wingfoil":
    case "kitesurf":
      return ["distance", "time_on_water", "best_10s", "sessions"];
    case "sailing":
      return ["distance", "time_on_water", "avg_speed", "sessions"];
    case "sup":
    case "kayak":
      return ["distance", "moving_time", "avg_pace", "sessions"];
    default:
      return ["distance", "time_on_water", "max_speed", "sessions"];
  }
}

// Sensible starting point for a user who hasn't onboarded yet. Not persisted
// until the first PATCH; GET flags it with `onboarded: false`.
function defaultValues(): ProfileValues {
  const primarySport: Sport = "windsurf";
  const goal: Goal = "improve_speed";
  return {
    primarySport,
    sports: [primarySport],
    experience: "intermediate",
    goal,
    focus: "speed",
    activityFilter: null,
    cardSlots: defaultSlots(primarySport, goal),
    defaultActivityPeriod: "week",
    windUnit: "kt",
    distanceUnit: "km",
    temperatureUnit: "c",
  };
}

const profileValues = (row: UserProfile): ProfileValues => ({
  primarySport: row.primarySport,
  sports: row.sports,
  experience: row.experience,
  goal: row.goal,
  focus: row.focus,
  activityFilter: row.activityFilter,
  cardSlots: row.cardSlots,
  defaultActivityPeriod: row.defaultActivityPeriod,
  windUnit: row.windUnit,
  distanceUnit: row.distanceUnit,
  temperatureUnit: row.temperatureUnit,
});

// Context needed to resolve a sport's EFFECTIVE card slots. The primary sport's
// slots live on user_profile, so both read paths (GET /profile and
// GET /sport-profiles) agree — single source of truth.
interface SlotContext {
  goal: Goal;
  primarySport: Sport;
  primaryCardSlots: SummaryMetric[];
}

export class UserProfileService extends BaseUseCase {
  constructor(private readonly repository: UserProfileRepository) {
    super();
  }

  /** Current profile, or the (unpersisted) defaults if the user hasn't onboarded. */
  async getProfile(user: RequestUser): Promise<ProfileResponse> {
    const row = await this.repository.findByUserId(user.id);
    return row
      ? { onboarded: true, ...profileValues(row) }
      : { onboarded: false, ...defaultValues() };
  }

  /** Partial update / upsert of the global profile (onboarding sends it full). */
  async updateProfile(
    user: RequestUser,
    input: UpdateProfileInput,
  ): Promise<ProfileResponse> {
    const saved = await this.repository.upsertProfileWithLock(
      user.id,
      (existing) => {
        const base: ProfileValues = existing
          ? profileValues(existing)
          : defaultValues();

        const primarySport = input.primarySport ?? base.primarySport;
        const goal = input.goal ?? base.goal;

        // Recompute default card slots when sport/goal changes (or on first
        // create) and the client didn't pin them — mirrors `applyGoalDefaults`.
        let cardSlots = input.cardSlots ?? base.cardSlots;
        if (
          !input.cardSlots &&
          (!existing ||
            primarySport !== base.primarySport ||
            goal !== base.goal)
        ) {
          cardSlots = defaultSlots(primarySport, goal);
        }

        return {
          primarySport,
          sports: input.sports ?? base.sports,
          experience: input.experience ?? base.experience,
          goal,
          focus: input.focus ?? base.focus,
          activityFilter:
            input.activityFilter !== undefined
              ? input.activityFilter
              : base.activityFilter,
          cardSlots,
          defaultActivityPeriod:
            input.defaultActivityPeriod ?? base.defaultActivityPeriod,
          windUnit: input.windUnit ?? base.windUnit,
          distanceUnit: input.distanceUnit ?? base.distanceUnit,
          temperatureUnit: input.temperatureUnit ?? base.temperatureUnit,
        };
      },
    );

    return { onboarded: true, ...profileValues(saved) };
  }

  async getSportProfiles(user: RequestUser): Promise<SportProfileResponse[]> {
    const ctx = await this.slotContext(user);
    const rows = await this.repository.listSportProfilesByUserId(user.id);
    return rows.map((row) => this.toSportProfileResponse(row, ctx));
  }

  /** Full replacement of a per-sport override (PUT). Omitted fields clear. */
  async upsertSportProfile(
    user: RequestUser,
    sport: Sport,
    input: UpsertSportProfileInput,
  ): Promise<SportProfileResponse> {
    const saved = await this.repository.upsertSportProfile(user.id, sport, {
      cardSlots: input.cardSlots ?? null,
      planingThresholdMps: input.planingThresholdMps ?? null,
      foilingThresholdMps: input.foilingThresholdMps ?? null,
      prefs: (input.prefs ?? null) as JsonValue | null,
    });

    const ctx = await this.slotContext(user);
    return this.toSportProfileResponse(saved, ctx);
  }

  private async slotContext(user: RequestUser): Promise<SlotContext> {
    const profile = await this.repository.findByUserId(user.id);
    const base = profile ? profileValues(profile) : defaultValues();
    return {
      goal: base.goal,
      primarySport: base.primarySport,
      primaryCardSlots: base.cardSlots,
    };
  }

  private toSportProfileResponse(
    row: UserSportProfile,
    ctx: SlotContext,
  ): SportProfileResponse {
    const cardSlots =
      row.cardSlots ??
      (row.sport === ctx.primarySport
        ? ctx.primaryCardSlots
        : defaultSlots(row.sport, ctx.goal));
    return {
      sport: row.sport,
      cardSlots,
      planingThresholdMps: row.planingThresholdMps,
      foilingThresholdMps: row.foilingThresholdMps,
    };
  }
}
