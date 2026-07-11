import type { Context } from "hono";

import { GenericError } from "@/packages/error";
import { rateLimit } from "./rate-limit.middleware";

const makeContext = (ip: string): Context =>
  ({
    req: {
      header: (name: string) => (name === "x-forwarded-for" ? ip : undefined),
    },
  }) as unknown as Context;

describe("rateLimit", () => {
  it("allows requests up to the max within a window", async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 3 });
    const c = makeContext("1.1.1.1");
    const next = jest.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 3; i++) {
      await mw(c, next);
    }

    expect(next).toHaveBeenCalledTimes(3);
  });

  it("throws RATE_LIMIT_EXCEEDED once the max is exceeded", async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2 });
    const c = makeContext("2.2.2.2");
    const next = jest.fn().mockResolvedValue(undefined);

    await mw(c, next);
    await mw(c, next);

    await expect(mw(c, next)).rejects.toMatchObject({
      errorCode: "RATE_LIMIT_EXCEEDED",
    });
    await expect(mw(c, next)).rejects.toBeInstanceOf(GenericError);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("tracks each client IP in its own bucket", async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const next = jest.fn().mockResolvedValue(undefined);

    await mw(makeContext("3.3.3.3"), next);
    await mw(makeContext("4.4.4.4"), next);

    expect(next).toHaveBeenCalledTimes(2);
  });
});
