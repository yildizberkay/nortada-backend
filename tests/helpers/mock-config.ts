import type { Config } from "@/app/global-config";

/** Creates a mock config matching the real Config interface. */
export function createMockConfig(overrides?: Partial<Config>): Config {
  return {
    environment: "dev",
    database: {
      url: "postgres://test:test@localhost:5432/test",
    },
    clerk: {
      secretKey: "test-clerk-secret",
      publishableKey: "test-clerk-pub",
    },
    auth: {
      anonymousJwtSecret: "test-anonymous-jwt-secret-32-chars-long!",
    },
    trigger: {
      secretKey: "test-trigger-secret",
      projectId: "proj_test",
    },
    osm: {
      overpassUrl: "https://overpass.test/api/interpreter",
    },
    openMeteo: {
      forecastUrl: "https://open-meteo.test/v1",
      marineUrl: "https://marine.open-meteo.test/v1",
    },
    ...overrides,
  };
}
