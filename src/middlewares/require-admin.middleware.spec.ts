import type { Context, Next } from "hono";

import { GenericError } from "@/packages/error";
import type { RequestUser } from "@/types";
import { requireAdmin } from "./require-admin.middleware";

const contextWithUser = (user: RequestUser | undefined): Context =>
  ({ var: { user } }) as unknown as Context;

const admin: RequestUser = {
  id: 1,
  uid: "a",
  isAnonymous: false,
  clerkUserId: "c",
  isAdmin: true,
};

describe("requireAdmin", () => {
  it("passes an admin user through", async () => {
    const next = jest.fn().mockResolvedValue(undefined) as unknown as Next;
    await requireAdmin(contextWithUser(admin), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("forbids a non-admin user (fails closed)", async () => {
    const next = jest.fn() as unknown as Next;
    await expect(
      requireAdmin(contextWithUser({ ...admin, isAdmin: false }), next),
    ).rejects.toMatchObject({ errorCode: "FORBIDDEN" });
    expect(next).not.toHaveBeenCalled();
  });

  it("forbids when no user is present (fails closed)", async () => {
    const next = jest.fn() as unknown as Next;
    await expect(
      requireAdmin(contextWithUser(undefined), next),
    ).rejects.toBeInstanceOf(GenericError);
    expect(next).not.toHaveBeenCalled();
  });
});
