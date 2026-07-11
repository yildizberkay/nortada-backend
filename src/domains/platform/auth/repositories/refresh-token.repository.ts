import { and, eq, isNull, lt } from "drizzle-orm";

import type { DBManager, NewRefreshToken, RefreshToken } from "@/db";
import type { DBExecutor } from "@/db/db.manager";
import { refreshTokenTable } from "@/db/schema";
import { BaseRepository } from "@/domains/platform/foundation";

// Explicit read allowlist (never SELECT *). The `token_hash` is included because
// lookups are BY hash; the raw token never exists in the DB.
const refreshTokenColumns = {
  id: true,
  uid: true,
  userId: true,
  tokenHash: true,
  familyId: true,
  expiresAt: true,
  revokedAt: true,
  replacedByHash: true,
  createdAt: true,
} as const;

export class RefreshTokenRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) {
    super(externalDBManager);
  }

  async create(values: NewRefreshToken): Promise<RefreshToken> {
    const [row] = await this.dbClient
      .insert(refreshTokenTable)
      .values(values)
      .returning();
    return row;
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | undefined> {
    return this.dbClient.query.refreshToken.findFirst({
      columns: refreshTokenColumns,
      where: eq(refreshTokenTable.tokenHash, tokenHash),
    });
  }

  /**
   * Atomic single-use rotation. Revokes the presented token ONLY if it is still
   * live (`revokedAt IS NULL`) and inserts the replacement, in one transaction.
   * Returns `null` when the conditional revoke matches no row — i.e. the token
   * was already rotated by a concurrent `/refresh` — so the caller can treat the
   * loser of the race as a reuse/theft signal. This is what makes single-use
   * enforceable under concurrency: the second transaction blocks on the row lock,
   * re-evaluates `revokedAt IS NULL` against the committed row, and matches 0.
   */
  async rotate(
    oldHash: string,
    replacement: NewRefreshToken,
  ): Promise<RefreshToken | null> {
    return this.dbClient.transaction(async (tx) => {
      const revoked = await tx
        .update(refreshTokenTable)
        .set({ revokedAt: new Date(), replacedByHash: replacement.tokenHash })
        .where(
          and(
            eq(refreshTokenTable.tokenHash, oldHash),
            isNull(refreshTokenTable.revokedAt),
          ),
        )
        .returning({ id: refreshTokenTable.id });
      if (revoked.length === 0) {
        return null;
      }
      const [row] = await tx
        .insert(refreshTokenTable)
        .values(replacement)
        .returning();
      return row;
    });
  }

  /** Reuse detection: revoke every still-live token in a rotation family (a
   * stolen token was replayed). */
  async revokeFamily(familyId: string): Promise<void> {
    await this.dbClient
      .update(refreshTokenTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokenTable.familyId, familyId),
          isNull(refreshTokenTable.revokedAt),
        ),
      );
  }

  /** Revoke all of a user's live refresh tokens — used when an anonymous session
   * is linked/retired. Accepts a tx so it runs inside the merge transaction. */
  async revokeAllForUser(
    userId: number,
    tx: DBExecutor = this.dbClient,
  ): Promise<void> {
    await tx
      .update(refreshTokenTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokenTable.userId, userId),
          isNull(refreshTokenTable.revokedAt),
        ),
      );
  }

  /** GC hook: delete EXPIRED rows only. Revoked-but-unexpired rows are kept —
   * they are the reuse-detection tripwires (deleting one would turn a replayed
   * stolen token into a lookup miss → INVALID instead of REUSED). An expired row
   * is already rejected by the expiry check, so deleting it is safe. Returns the
   * number of rows deleted. */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const deleted = await this.dbClient
      .delete(refreshTokenTable)
      .where(lt(refreshTokenTable.expiresAt, now))
      .returning({ id: refreshTokenTable.id });
    return deleted.length;
  }
}
