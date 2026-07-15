declare namespace NodeJS {
  interface ProcessEnv {
    PORT?: string;
    ENVIRONMENT: "prod" | "dev";
    DATABASE_URL: string;

    // Deploy-time log verbosity override (silly|debug|info|warn|error).
    // Unset → prod=info, dev=debug (see src/packages/logger).
    LOG_LEVEL?: string;

    // Clerk (real logins — RFC-0002). Optional at boot so local/dev can run
    // anonymous-only without Clerk configured.
    CLERK_SECRET_KEY?: string;
    CLERK_PUBLISHABLE_KEY?: string;
    // Comma-separated authorized parties (azp) for Clerk session tokens.
    CLERK_AUTHORIZED_PARTIES?: string;

    // Our own anonymous-device JWT signing secret (RFC-0002). HS256 — must be
    // ≥32 chars in production (enforced in global-config). Deliberately unset
    // in the Trigger worker, which never signs these tokens.
    AUTH_ANONYMOUS_JWT_SECRET?: string;

    // Trigger.dev runtime.
    TRIGGER_SECRET_KEY?: string;
    // Set to "true" inside the Trigger worker so infra can branch on it.
    TRIGGER_WORKER?: string;

    // OpenStreetMap Overpass API endpoint (spot ingest — RFC-0004).
    OSM_OVERPASS_URL?: string;

    // Open-Meteo endpoints (weather — RFC-0005).
    OPEN_METEO_BASE_URL?: string;
    OPEN_METEO_MARINE_URL?: string;
  }
}
