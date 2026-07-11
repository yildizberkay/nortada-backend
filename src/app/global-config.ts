import { z } from "zod";

/**
 * Typed application config. Services/repositories read this via `this.config`
 * (never `globalConfig` directly). Only infra (`db.manager`, `container`,
 * `initialize-services`) touches `globalConfig.config`.
 *
 * Namespaced by concern so new integrations slot in as a new key. Env variable
 * names follow `{NAMESPACE}_{SERVICE}_{CREDENTIAL}` where applicable.
 */
export interface Config {
  environment: "prod" | "dev";

  database: {
    url: string;
  };

  // Clerk — real logins (RFC-0002). Optional so local/dev can boot
  // anonymous-only without Clerk configured.
  clerk: {
    secretKey?: string;
    publishableKey?: string;
  };

  // Our own anonymous-device auth (RFC-0002). `anonymousJwtSecret` signs the
  // stateless HS256 tokens issued to anonymous devices.
  auth: {
    anonymousJwtSecret: string;
  };

  trigger: {
    secretKey?: string;
    projectId?: string;
  };
}

// Whether we are running inside the Trigger.dev worker. Background tasks never
// sign/verify the anonymous JWT, so the prod secret-length rule is relaxed
// there (a secret they never use must not crash unrelated jobs).
const isTriggerWorker = () => process.env.TRIGGER_WORKER === "true";

/**
 * Env schema — the single fail-fast gate. A missing/invalid `ENVIRONMENT` would
 * otherwise land the app between "prod" and "dev" (fail-fast disabled, docs off)
 * with an unvalidated JWT secret; parsing here makes that impossible.
 */
const envSchema = z
  .object({
    ENVIRONMENT: z.enum(["prod", "dev"]),
    DATABASE_URL: z.string().min(1),
    AUTH_ANONYMOUS_JWT_SECRET: z.string().min(1),
    CLERK_SECRET_KEY: z.string().optional(),
    CLERK_PUBLISHABLE_KEY: z.string().optional(),
    TRIGGER_SECRET_KEY: z.string().optional(),
    TRIGGER_PROJECT_ID: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    // In production a short/empty HS256 key signs forgeable device tokens.
    if (
      val.ENVIRONMENT === "prod" &&
      !isTriggerWorker() &&
      val.AUTH_ANONYMOUS_JWT_SECRET.length < 32
    ) {
      ctx.addIssue({
        code: "custom",
        message: "AUTH_ANONYMOUS_JWT_SECRET must be ≥32 chars in production",
        path: ["AUTH_ANONYMOUS_JWT_SECRET"],
      });
    }
  });

export class GlobalConfig {
  private _config?: Config;

  get config(): Config {
    if (!this._config) {
      throw new Error("GlobalConfig is not initialized");
    }
    return this._config;
  }

  get isDev(): boolean {
    return this._config?.environment === "dev";
  }

  initialize() {
    if (this._config) {
      return;
    }

    const env = envSchema.parse(process.env);

    this._config = {
      environment: env.ENVIRONMENT,
      database: {
        url: env.DATABASE_URL,
      },
      clerk: {
        secretKey: env.CLERK_SECRET_KEY,
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
      },
      auth: {
        anonymousJwtSecret: env.AUTH_ANONYMOUS_JWT_SECRET,
      },
      trigger: {
        secretKey: env.TRIGGER_SECRET_KEY,
        projectId: env.TRIGGER_PROJECT_ID,
      },
    };
  }
}

export const globalConfig = new GlobalConfig();
