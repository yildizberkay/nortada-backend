import { and, eq, inArray } from "drizzle-orm";

import type {
  DBManager,
  NewUserProfile,
  NewUserSportProfile,
  UserProfile,
  UserSportProfile,
} from "@/db";
import type { DBExecutor } from "@/db/db.manager";
import { userProfileTable, userSportProfileTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

const profileColumns = {
  id: true,
  uid: true,
  userId: true,
  primarySport: true,
  sports: true,
  experience: true,
  goal: true,
  focus: true,
  activityFilter: true,
  cardSlots: true,
  defaultActivityPeriod: true,
  windUnit: true,
  distanceUnit: true,
  temperatureUnit: true,
  createdAt: true,
  updatedAt: true,
} as const;

const sportProfileColumns = {
  id: true,
  uid: true,
  userId: true,
  sport: true,
  cardSlots: true,
  prefs: true,
  createdAt: true,
  updatedAt: true,
} as const;

// The mutable columns of user_profile (everything the service computes) — the
// insert values minus the identity/system columns.
type ProfileValues = Omit<
  NewUserProfile,
  "id" | "uid" | "userId" | "createdAt" | "updatedAt"
>;

export class UserProfileRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  async findByUserId(userId: number): Promise<UserProfile | undefined> {
    return this.dbClient.query.userProfile.findFirst({
      columns: profileColumns,
      where: eq(userProfileTable.userId, userId),
    });
  }

  /**
   * Insert-or-update the single global profile row under a row lock. Reads the
   * existing row `FOR UPDATE`, hands it to `compute` (the service's merge/
   * defaults logic), then writes — serializing concurrent partial PATCHes so a
   * disjoint edit from another device can't silently revert (no lost update).
   */
  async upsertProfileWithLock(
    userId: number,
    compute: (existing: UserProfile | undefined) => ProfileValues,
  ): Promise<UserProfile> {
    return this.dbClient.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(userProfileTable)
        .where(eq(userProfileTable.userId, userId))
        .for("update")
        .limit(1);

      const values = compute(existing);
      const [row] = await tx
        .insert(userProfileTable)
        .values({ userId, ...values })
        .onConflictDoUpdate({
          target: userProfileTable.userId,
          set: { ...values, updatedAt: new Date() },
        })
        .returning();
      return row;
    });
  }

  async listSportProfilesByUserId(userId: number): Promise<UserSportProfile[]> {
    return this.dbClient.query.userSportProfile.findMany({
      columns: sportProfileColumns,
      where: eq(userSportProfileTable.userId, userId),
    });
  }

  async findSportProfile(
    userId: number,
    sport: UserSportProfile["sport"],
  ): Promise<UserSportProfile | undefined> {
    return this.dbClient.query.userSportProfile.findFirst({
      columns: sportProfileColumns,
      where: and(
        eq(userSportProfileTable.userId, userId),
        eq(userSportProfileTable.sport, sport),
      ),
    });
  }

  /**
   * Full-replace upsert of a per-(user, sport) override row. PUT semantics —
   * the caller supplies the complete override representation, so there is no
   * read-modify-write and thus no lost-update window.
   */
  async upsertSportProfile(
    userId: number,
    sport: UserSportProfile["sport"],
    values: Omit<
      NewUserSportProfile,
      "id" | "uid" | "userId" | "sport" | "createdAt" | "updatedAt"
    >,
  ): Promise<UserSportProfile> {
    const [row] = await this.dbClient
      .insert(userSportProfileTable)
      .values({ userId, sport, ...values })
      .onConflictDoUpdate({
        target: [userSportProfileTable.userId, userSportProfileTable.sport],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  /**
   * Merge preferences from an anonymous identity into an existing account.
   * The existing account is canonical: its global profile and per-sport rows
   * win every collision. Anonymous rows only fill gaps, and losing source rows
   * are removed instead of being stranded on the retired identity.
   *
   * Runs on the auth merge transaction so preference resolution, owned-data
   * reassignment, token revocation, and source retirement commit atomically.
   */
  async mergeIntoExistingAccount(
    fromUserId: number,
    toUserId: number,
    tx: DBExecutor,
  ): Promise<void> {
    const [targetProfile] = await tx
      .select({ id: userProfileTable.id })
      .from(userProfileTable)
      .where(eq(userProfileTable.userId, toUserId))
      .limit(1);

    if (targetProfile) {
      await tx
        .delete(userProfileTable)
        .where(eq(userProfileTable.userId, fromUserId));
    } else {
      await tx
        .update(userProfileTable)
        .set({ userId: toUserId })
        .where(eq(userProfileTable.userId, fromUserId));
    }

    const targetSportProfiles = await tx
      .select({ sport: userSportProfileTable.sport })
      .from(userSportProfileTable)
      .where(eq(userSportProfileTable.userId, toUserId));
    const targetSports = targetSportProfiles.map(({ sport }) => sport);

    if (targetSports.length > 0) {
      await tx
        .delete(userSportProfileTable)
        .where(
          and(
            eq(userSportProfileTable.userId, fromUserId),
            inArray(userSportProfileTable.sport, targetSports),
          ),
        );
    }

    await tx
      .update(userSportProfileTable)
      .set({ userId: toUserId })
      .where(eq(userSportProfileTable.userId, fromUserId));
  }
}
