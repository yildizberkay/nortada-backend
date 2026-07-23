import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger as triggerLogger } from "@trigger.dev/sdk";
import { pino } from "pino";

const isTrigger = () => {
  return process.env.TRIGGER_WORKER === "true";
};

export type LogLevel = "silly" | "debug" | "info" | "warn" | "error";

// Our level names → pino's ("silly" is a winston-ism; pino calls it "trace").
const PINO_LEVEL = {
  silly: "trace",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
} as const satisfies Record<LogLevel, string>;

const isValidLevel = (value: string): value is LogLevel => value in PINO_LEVEL;

/**
 * Deploy-time level control: an explicit `LOG_LEVEL` env always wins
 * (silly|debug|info|warn|error); otherwise prod defaults to `info` and dev to
 * `debug`, so verbose logs (incl. per-request HTTP logging) are on locally and
 * off in prod until opened with `LOG_LEVEL=debug` on a deploy. Tests default to
 * `silent` because pino writes straight to stdout, bypassing `jest --silent`.
 *
 * Reads env directly (not globalConfig) so the logger has zero coupling to the
 * config layer and works before init.
 */
export function resolveLogLevel(
  env: Record<string, string | undefined> = process.env,
): LogLevel | "silent" {
  const raw = env.LOG_LEVEL?.toLowerCase();
  if (raw !== undefined && isValidLevel(raw)) {
    return raw;
  }
  if (env.JEST_WORKER_ID !== undefined) {
    return "silent";
  }
  return env.ENVIRONMENT === "prod" ? "info" : "debug";
}

const level = resolveLogLevel();
const pinoLevel = level === "silent" ? "silent" : PINO_LEVEL[level];

// Pretty human-readable lines locally; raw single-line JSON everywhere else so
// log collectors can parse fields. Never pretty inside Trigger workers or tests
// (the transport spawns a worker thread those runtimes shouldn't carry).
const usePretty =
  process.env.ENVIRONMENT !== "prod" &&
  !isTrigger() &&
  process.env.JEST_WORKER_ID === undefined;

// Keep one shared, human-readable local log that both the developer and coding
// agents can inspect. Module initialization happens once per server process, so
// truncating here gives every fresh `npm run dev` / watcher restart a clean log.
// Production, Trigger workers, and tests never touch the filesystem.
const localLogPath = resolve(process.cwd(), ".logs", "development.log");
if (usePretty) {
  mkdirSync(dirname(localLogPath), { recursive: true });
  writeFileSync(localLogPath, "");
}

const root = pino({
  level: pinoLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  // Drop pino's default pid/hostname bindings — noise on a single-instance app.
  base: undefined,
  ...(usePretty
    ? {
        transport: {
          targets: [
            {
              target: "pino-pretty",
              level: pinoLevel,
              options: {
                translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
                messageFormat: "[{prefix}] {msg}",
                ignore: "prefix",
              },
            },
            {
              target: "pino-pretty",
              level: pinoLevel,
              options: {
                colorize: false,
                destination: localLogPath,
                translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
                messageFormat: "[{prefix}] {msg}",
                ignore: "prefix",
              },
            },
          ],
        },
      }
    : {}),
});

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  silly(message: string, data?: unknown): void;
}

// `Error` props are non-enumerable, so a raw Error inside `data` JSON-serializes
// to `{}` and the log loses the one thing it was for. Flatten errors (top level
// or one level deep) into plain {name, message, stack, cause} objects.
const serializeError = (error: Error): Record<string, unknown> => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
  ...(error.cause !== undefined
    ? {
        cause: error.cause instanceof Error ? error.cause.message : error.cause,
      }
    : {}),
});

const normalizeData = (data: unknown): unknown => {
  if (data instanceof Error) return serializeError(data);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = value instanceof Error ? serializeError(value) : value;
    }
    return out;
  }
  return data;
};

export function createLogger(prefix: string): Logger {
  const child = root.child({ prefix });

  const log = (logLevel: LogLevel, message: string, rawData?: unknown) => {
    const pinoLevel = PINO_LEVEL[logLevel];
    if (!child.isLevelEnabled(pinoLevel)) {
      return;
    }
    const data = rawData === undefined ? undefined : normalizeData(rawData);

    // Trigger.dev runs also mirror the line into the run's structured log
    // viewer (stdout alone doesn't surface there with levels intact).
    if (isTrigger()) {
      const args = [
        `${prefix}: ${message}`,
        { level: logLevel, data },
      ] as const;
      switch (logLevel) {
        case "error":
          triggerLogger.error(...args);
          break;
        case "warn":
          triggerLogger.warn(...args);
          break;
        default:
          triggerLogger.log(...args);
      }
    }

    if (data === undefined) {
      child[pinoLevel](message);
    } else {
      // Nest under `data` (not spread) so caller fields can never collide with
      // pino's own (level/time/msg/prefix).
      child[pinoLevel]({ data }, message);
    }
  };

  return {
    debug: (message: string, data?: unknown) => log("debug", message, data),
    info: (message: string, data?: unknown) => log("info", message, data),
    warn: (message: string, data?: unknown) => log("warn", message, data),
    error: (message: string, data?: unknown) => log("error", message, data),
    silly: (message: string, data?: unknown) => log("silly", message, data),
  };
}
