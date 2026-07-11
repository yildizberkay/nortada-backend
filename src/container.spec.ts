import type { DBManager } from "@/db/db.manager";

import { buildContainer, getContainer } from "./container";

describe("buildContainer", () => {
  const fakeDBManager = {
    client: {} as never,
    reset: async () => {},
  } satisfies DBManager;

  it("builds a container without touching config or the database", () => {
    const container = buildContainer(fakeDBManager);
    expect(container).toBeDefined();
    expect(typeof container).toBe("object");
  });
});

describe("getContainer", () => {
  it("returns a stable memoized singleton", () => {
    expect(getContainer()).toBe(getContainer());
  });
});
