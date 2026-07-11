import { and, eq, isNull } from "drizzle-orm";

import type { DBManager, NewUser, User } from "@/db";
import { userTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

// Explicit column selection (never SELECT *): every read returns exactly this
// set, so a future sensitive column added to `user` (e.g. a token hash) can't
// silently leak — it must be added here deliberately. All current consumers
// (auth verify + /me + link) need the full identity row.
const userColumns = {
  id: true,
  uid: true,
  clerkUserId: true,
  isAnonymous: true,
  anonymousDeviceId: true,
  email: true,
  displayName: true,
  mergedIntoUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PG_UNIQUE_VIOLATION = "23505";

// Postgres surfaces a unique-index conflict as SQLSTATE 23505. Drizzle may wrap
// the driver error, so check the cause too.
const isUniqueViolation = (error: unknown): boolean => {
  const code = (error as { code?: string }).code;
  const causeCode = (error as { cause?: { code?: string } }).cause?.code;
  return code === PG_UNIQUE_VIOLATION || causeCode === PG_UNIQUE_VIOLATION;
};

export class UserRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  async findByUid(uid: string): Promise<User | undefined> {
    return this.dbClient.query.user.findFirst({
      columns: userColumns,
      where: eq(userTable.uid, uid),
    });
  }

  async findByClerkUserId(clerkUserId: string): Promise<User | undefined> {
    return this.dbClient.query.user.findFirst({
      columns: userColumns,
      where: eq(userTable.clerkUserId, clerkUserId),
    });
  }

  /** Only ever returns a LIVE anonymous row — a retired (merged) row is skipped
   * so a device that signed out of Clerk can re-bootstrap a fresh identity. */
  async findByAnonymousDeviceId(
    anonymousDeviceId: string,
  ): Promise<User | undefined> {
    return this.dbClient.query.user.findFirst({
      columns: userColumns,
      where: and(
        eq(userTable.anonymousDeviceId, anonymousDeviceId),
        isNull(userTable.mergedIntoUserId),
      ),
    });
  }

  /**
   * Idempotent create for an anonymous device. `ON CONFLICT DO NOTHING` +
   * re-read collapses a concurrent double-`/anonymous` to the single winning
   * row instead of throwing a 23505 that would surface as a 500.
   */
  async createAnonymous(anonymousDeviceId: string): Promise<User> {
    const [row] = await this.dbClient
      .insert(userTable)
      .values({ isAnonymous: true, anonymousDeviceId })
      .onConflictDoNothing()
      .returning();
    if (row) return row;

    const existing = await this.findByAnonymousDeviceId(anonymousDeviceId);
    if (!existing) {
      throw new Error(
        "createAnonymous: insert conflicted but no live row was found",
      );
    }
    return existing;
  }

  /**
   * Idempotent create for a Clerk user — same race guard as `createAnonymous`
   * against the `clerk_user_id` partial-unique index (parallel first requests
   * on cold app launch).
   */
  async createClerkUser(
    values: Pick<NewUser, "clerkUserId" | "email" | "displayName">,
  ): Promise<User> {
    const [row] = await this.dbClient
      .insert(userTable)
      .values({ ...values, isAnonymous: false })
      .onConflictDoNothing()
      .returning();
    if (row) return row;

    const clerkUserId = values.clerkUserId;
    const existing = clerkUserId
      ? await this.findByClerkUserId(clerkUserId)
      : undefined;
    if (!existing) {
      throw new Error(
        "createClerkUser: insert conflicted but no row was found",
      );
    }
    return existing;
  }

  /**
   * Merge branch 1: no pre-existing Clerk row — upgrade the anonymous row in
   * place. Returns `null` (not throws) when a concurrent request already
   * claimed this `clerkUserId` (23505), so the caller can fall through to the
   * merge-into-existing branch instead of 500ing.
   */
  async tryUpgradeAnonymousToClerk(
    userId: number,
    values: Pick<NewUser, "clerkUserId" | "email" | "displayName">,
  ): Promise<User | null> {
    try {
      const [row] = await this.dbClient
        .update(userTable)
        .set({ ...values, isAnonymous: false, anonymousDeviceId: null })
        .where(eq(userTable.id, userId))
        .returning();
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Merge branch 2: a Clerk row already exists — retire the anonymous row by
   * pointing it at the target AND freeing its `anonymousDeviceId` (so the same
   * device can re-bootstrap later). Future domains will reassign owned records
   * (activities/favorites/alerts) to `targetUserId` before this marker is set;
   * see docs/otonom-kararlar.md for the cross-domain transaction plan.
   */
  async markMergedInto(
    anonymousUserId: number,
    targetUserId: number,
  ): Promise<void> {
    await this.dbClient
      .update(userTable)
      .set({ mergedIntoUserId: targetUserId, anonymousDeviceId: null })
      .where(eq(userTable.id, anonymousUserId));
  }
}
