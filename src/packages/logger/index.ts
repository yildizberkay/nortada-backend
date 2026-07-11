import { logger } from "@trigger.dev/sdk";

const isTrigger = () => {
  return process.env.TRIGGER_WORKER === "true";
};

type LogLevel = "silly" | "debug" | "info" | "warn" | "error";

// Ordered least→most severe. The filter suppresses any level BELOW
// `currentLevel`, so `silly` (lowest) is the most suppressible — the opposite
// ordering would make it impossible to ever quiet `silly` output.
const LOG_LEVELS: Record<LogLevel, number> = {
  silly: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// Read straight from env (not globalConfig) so the logger has zero coupling to
// the config layer and works before init. Prod quiets silly/debug; dev is
// verbose.
const currentLevel: LogLevel =
  process.env.ENVIRONMENT === "prod" ? "info" : "debug";

function formatMessage(
  prefix: string,
  level: LogLevel,
  message: string,
  data?: unknown,
) {
  const timestamp = new Date().toISOString();
  return JSON.stringify({
    level,
    message,
    timestamp,
    prefix,
    data,
  });
}

function formatForTrigger(
  prefix: string,
  level: LogLevel,
  message: string,
  data?: unknown,
) {
  return [
    `${prefix}: ${message}`,
    {
      level,
      data,
    },
  ] as const;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  silly(message: string, data?: unknown): void;
}

export function createLogger(prefix: string): Logger {
  const log = (level: LogLevel, message: string, data?: unknown) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) {
      return;
    }

    if (isTrigger()) {
      const formattedForTrigger = formatForTrigger(
        prefix,
        level,
        message,
        data,
      );
      switch (level) {
        case "error":
          logger.error(...formattedForTrigger);
          break;
        case "warn":
          logger.warn(...formattedForTrigger);
          break;
        default:
          logger.log(...formattedForTrigger);
      }
    }

    const formatted = formatMessage(prefix, level, message, data);
    switch (level) {
      case "error":
        console.error(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
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
