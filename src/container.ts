import { type DBManager, getDBManager } from "@/db/db.manager";

/**
 * Dependencies every domain module receives. Only `db` lives here — it is the
 * one dependency that differs between the HTTP singleton (shared pool) and a
 * Trigger.dev task (per-task pool). Config is NOT injected: services read the
 * true-global config via `this.config` (BaseUseCase). Cross-domain services
 * (e.g. activity → weather) are passed explicitly at the call site below.
 */
export interface ModuleDeps {
  db: DBManager;
}

/**
 * Composition root. Each domain exposes `create<Domain>Module(deps)` that wires
 * its repositories internally and returns only its public services; here we
 * merge them in dependency order. See RFC-0001 §6 for the rationale (why this
 * replaces brandscale's central lazy-getter `ServiceContainer`).
 *
 * IMPORTANT: this function is pure and import-safe — it touches neither config
 * nor the DB at construction (module constructors must be cheap too). That lets
 * any entry point (HTTP, Trigger worker, tests) import it before
 * `initializeApp()`/`initializeForTrigger()` has run.
 */
export function buildContainer(db: DBManager) {
  // Threaded to each module so repositories bind to the right pool. Domains
  // land here from RFC-0002 onwards, e.g.:
  //   const deps: ModuleDeps = { db };
  //   const user = createUserModule(deps);
  //   const weather = createWeatherModule(deps);
  //   const activity = createActivityModule({ ...deps, weatherService: weather.weatherService });
  //   return { ...user, ...weather, ...activity };
  // biome-ignore lint/correctness/noUnusedVariables: consumed as modules are composed (RFC-0002+)
  const deps: ModuleDeps = { db };

  return {};
}

export type Container = ReturnType<typeof buildContainer>;

let _container: Container | undefined;

/**
 * Lazily-built HTTP-process singleton. Built on first access (after config/DB
 * are initialized), so importing `@/container` is a pure side-effect-free
 * operation — a Trigger task can import `buildContainer` without triggering an
 * HTTP-graph build. Trigger tasks build their own graph with `buildContainer(db)`.
 */
export const getContainer = (): Container => {
  if (!_container) {
    _container = buildContainer(getDBManager());
  }
  return _container;
};
