import type { Context, Next } from "hono";

const mockDebug = jest.fn();

jest.mock("@/packages/logger", () => ({
  createLogger: () => ({
    debug: mockDebug,
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

// Imported after the mock so the module-level logger is the mocked one.
import { requestLogger } from "./request-logger.middleware";

const makeContext = (overrides?: {
  path?: string;
  query?: Record<string, string>;
  userUid?: string;
}): Context =>
  ({
    req: {
      method: "GET",
      path: overrides?.path ?? "/v1/spots",
      query: () => overrides?.query ?? {},
    },
    res: { status: 200 },
    var: {
      user: overrides?.userUid ? { uid: overrides.userUid } : undefined,
    },
  }) as unknown as Context;

describe("requestLogger", () => {
  beforeEach(() => {
    mockDebug.mockClear();
  });

  it("logs method, path, status and duration after the handler ran", async () => {
    const next = jest.fn().mockResolvedValue(undefined) as unknown as Next;
    await requestLogger()(makeContext({ userUid: "u-1" }), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockDebug).toHaveBeenCalledWith(
      "GET /v1/spots → 200",
      expect.objectContaining({
        method: "GET",
        path: "/v1/spots",
        status: 200,
        durationMs: expect.any(Number),
        userUid: "u-1",
      }),
    );
  });

  it("includes query params only when present", async () => {
    const next = jest.fn().mockResolvedValue(undefined) as unknown as Next;
    await requestLogger()(makeContext({ query: { lat: "36.8" } }), next);

    expect(mockDebug).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: { lat: "36.8" } }),
    );

    mockDebug.mockClear();
    await requestLogger()(makeContext(), next);
    expect(mockDebug.mock.calls[0][1]).not.toHaveProperty("query");
  });

  it("skips health probes entirely", async () => {
    const next = jest.fn().mockResolvedValue(undefined) as unknown as Next;
    await requestLogger()(makeContext({ path: "/health" }), next);
    await requestLogger()(makeContext({ path: "/health/ready" }), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(mockDebug).not.toHaveBeenCalled();
  });
});
