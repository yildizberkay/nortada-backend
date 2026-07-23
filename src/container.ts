import { type DBManager, getDBManager } from "@/db/db.manager";
import { createActivityModule } from "@/domains/feature/activity/activity.module";
import { createBriefingModule } from "@/domains/feature/briefing/briefing.module";
import { createSpotModule } from "@/domains/feature/spot/spot.module";
import { createWeatherModule } from "@/domains/feature/weather/weather.module";
import { createWeatherMapModule } from "@/domains/feature/weathermap/weathermap.module";
import { createAuthModule } from "@/domains/platform/auth/auth.module";
import { createUserModule } from "@/domains/platform/user/user.module";

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
  // Threaded to each module so repositories bind to the right pool. Cross-domain
  // services are passed explicitly, e.g.:
  //   const activity = createActivityModule({ ...deps, weatherService: weather.weatherService });
  const deps: ModuleDeps = { db };

  // Data-owning modules are built before auth so their merge hooks (D-008) can
  // be threaded into the auth module explicitly.
  const { userProfileReassigner, ...userServices } = createUserModule(deps);
  const spot = createSpotModule(deps);
  const { favoriteReassigner, ...spotServices } = spot;
  const { activityReassigner, ...activityServices } =
    createActivityModule(deps);

  // Auth is built after the data-owning domains so their merge hooks (D-008)
  // can be threaded in explicitly.
  const auth = createAuthModule({
    ...deps,
    mergeReassigners: [
      userProfileReassigner,
      favoriteReassigner,
      activityReassigner,
    ],
  });
  // Weather depends on spot (geo lookup + favorites hot set) — passed explicitly
  // as a minimal port (SpotService satisfies it).
  const weather = createWeatherModule({
    ...deps,
    spotPort: spotServices.spotService,
  });
  // Weather-map pipeline (RFC-0011) — self-contained (spatial archive + object
  // storage), no cross-domain ports.
  const weatherMap = createWeatherMapModule(deps);
  // Briefing composes over spot + user + weather — pure ports, no repositories
  // of its own (RFC-0010).
  const briefing = createBriefingModule({
    ...deps,
    favoritePort: spotServices.favoriteService,
    spotPort: spotServices.spotService,
    profilePort: userServices.userProfileService,
    weatherPort: weather.weatherService,
  });

  return {
    ...auth,
    ...userServices,
    ...spotServices,
    ...weather,
    ...weatherMap,
    ...briefing,
    ...activityServices,
  };
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
