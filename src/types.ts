/**
 * A domain's hook to move its user-owned rows during an anonymous→Clerk merge
 * (D-008). Each data-owning domain (spot/favorites, later activity) exposes one;
 * the composition root collects them and the auth merge runs them inside ONE
 * transaction (the `tx` here) so reassignment + retire are atomic. Takes an
 * opaque DB executor — the domain never learns who called it.
 */
export type MergeReassigner = (
  fromUserId: number,
  toUserId: number,
  tx: import("@/db/db.manager").DBExecutor,
) => Promise<void>;

/**
 * The authenticated principal attached to a request by the auth middleware
 * (RFC-0002). Covers BOTH auth sources: anonymous devices (our own JWT) and
 * real Clerk logins — routes read `c.var.user` without caring which. This is
 * the request-context identity, distinct from the DB-inferred `User` row.
 */
export interface RequestUser {
  id: number;
  uid: string;
  isAnonymous: boolean;
  clerkUserId: string | null;
  isAdmin: boolean;
}

export type Variables<IsUserOptional extends boolean> =
  IsUserOptional extends true ? { user?: RequestUser } : { user: RequestUser };

/**
 * Hono context type. Use `new Hono<HonoContext>()` for authenticated routes and
 * `new Hono<HonoContext<true>>()` for routes where the user is optional.
 */
export type HonoContext<IsUserOptional extends boolean = false> = {
  Variables: Variables<IsUserOptional>;
};
