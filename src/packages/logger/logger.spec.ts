import { createLogger, resolveLogLevel } from "./index";

describe("resolveLogLevel", () => {
  it("honors an explicit LOG_LEVEL over every default", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "warn", ENVIRONMENT: "prod" })).toBe(
      "warn",
    );
    expect(resolveLogLevel({ LOG_LEVEL: "silly", JEST_WORKER_ID: "1" })).toBe(
      "silly",
    );
  });

  it("accepts LOG_LEVEL case-insensitively", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "ERROR" })).toBe("error");
  });

  it("falls back on an invalid LOG_LEVEL instead of crashing", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "verbose", ENVIRONMENT: "prod" })).toBe(
      "info",
    );
  });

  it("defaults to info in prod and debug elsewhere", () => {
    expect(resolveLogLevel({ ENVIRONMENT: "prod" })).toBe("info");
    expect(resolveLogLevel({ ENVIRONMENT: "dev" })).toBe("debug");
    expect(resolveLogLevel({})).toBe("debug");
  });

  it("defaults to silent under jest so pino stays off stdout", () => {
    expect(resolveLogLevel({ JEST_WORKER_ID: "1" })).toBe("silent");
  });
});

describe("createLogger", () => {
  it("returns a logger whose every level is callable", () => {
    const logger = createLogger("spec");
    expect(() => {
      logger.silly("silly", { a: 1 });
      logger.debug("debug");
      logger.info("info", "primitive data");
      logger.warn("warn", { nested: { b: 2 } });
      logger.error("error", { err: "boom" });
    }).not.toThrow();
  });
});
