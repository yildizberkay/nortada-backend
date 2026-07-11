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
