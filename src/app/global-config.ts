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
    // PEM public key → networkless token verification (no per-request JWKS
    // fetch). Strongly preferred in prod.
    jwtKey?: string;
    // Expected token-issuing frontends (azp check). Verifies a token was minted
    // for our app, not another party in the Clerk instance.
    authorizedParties?: string[];
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

  // OpenStreetMap Overpass API — spot ingest source (RFC-0004). ODbL: attribute
  // "© OpenStreetMap contributors" in any UI surfacing this data.
  osm: {
    overpassUrl: string;
  };

  // Open-Meteo — weather source (RFC-0005). No API key for non-commercial use;
  // attribute "Weather data by Open-Meteo.com".
  openMeteo: {
    forecastUrl: string;
    marineUrl: string;
  };

  // Object storage — the raw GPS track blob store (RFC-0006, S3/R2/MinIO). Bucket
  // is optional so local/dev/tests boot without it; the S3 client fails clearly
  // at first use if unset, and prod requires it (env refine below).
  objectStorage: {
    bucket?: string;
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
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
    CLERK_JWT_KEY: z.string().optional(),
    // Comma-separated list of authorized parties (azp) for Clerk tokens.
    CLERK_AUTHORIZED_PARTIES: z.string().optional(),
    TRIGGER_SECRET_KEY: z.string().optional(),
    TRIGGER_PROJECT_ID: z.string().optional(),
    OSM_OVERPASS_URL: z
      .string()
      .default("https://overpass-api.de/api/interpreter"),
    OPEN_METEO_BASE_URL: z.string().default("https://api.open-meteo.com/v1"),
    OPEN_METEO_MARINE_URL: z
      .string()
      .default("https://marine-api.open-meteo.com/v1"),
    OBJECT_STORAGE_BUCKET: z.string().optional(),
    OBJECT_STORAGE_REGION: z.string().default("auto"),
    OBJECT_STORAGE_ENDPOINT: z.string().optional(),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().optional(),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
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
    // Object storage backs the raw GPS track for BOTH the HTTP upload and the
    // Trigger metrics read, so it's required in prod regardless of worker role.
    if (val.ENVIRONMENT === "prod" && !val.OBJECT_STORAGE_BUCKET) {
      ctx.addIssue({
        code: "custom",
        message: "OBJECT_STORAGE_BUCKET is required in production",
        path: ["OBJECT_STORAGE_BUCKET"],
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
        jwtKey: env.CLERK_JWT_KEY,
        authorizedParties: env.CLERK_AUTHORIZED_PARTIES?.split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      },
      auth: {
        anonymousJwtSecret: env.AUTH_ANONYMOUS_JWT_SECRET,
      },
      trigger: {
        secretKey: env.TRIGGER_SECRET_KEY,
        projectId: env.TRIGGER_PROJECT_ID,
      },
      osm: {
        overpassUrl: env.OSM_OVERPASS_URL,
      },
      openMeteo: {
        forecastUrl: env.OPEN_METEO_BASE_URL,
        marineUrl: env.OPEN_METEO_MARINE_URL,
      },
      objectStorage: {
        bucket: env.OBJECT_STORAGE_BUCKET,
        region: env.OBJECT_STORAGE_REGION,
        endpoint: env.OBJECT_STORAGE_ENDPOINT,
        accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
        forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
      },
    };
  }
}

export const globalConfig = new GlobalConfig();
