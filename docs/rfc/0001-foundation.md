# RFC-0001: Project Foundation & Architecture

|                |                    |
| -------------- | ------------------ |
| **RFC**        | 0001               |
| **Title**      | Project Foundation & Architecture |
| **Status**     | ✅ Completed        |
| **Step**       | 0                  |
| **Depends on** | —                  |
| **Domain(s)**  | platform/foundation |
| **Updated**    | 2026-07-11         |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

---

## 1. Summary

This RFC establishes the running skeleton of the Nortada backend: a TypeScript service on
**Hono + Drizzle ORM + PostgreSQL (`pg`) + Zod v4 + Trigger.dev**, deployed (target) on
Railway, following the layered, bounded-context patterns proven in the reference codebase
([[reference/brandscale-architecture]]). It defines the layer contract (`route → service →
repository → drizzle`), the base classes that enforce it, the error/config/logging/OpenAPI/DB
plumbing, the test/lint/build toolchain, and health endpoints.

The one deliberate departure from the reference architecture is **dependency injection**:
instead of a single central `ServiceContainer` with ~40 lazy getters, each domain wires
itself in a small `create<Domain>Module(deps)` function, and a root `buildContainer(db)`
composes them in dependency order. Every subsequent RFC adds a bounded context on top of this
foundation without modifying it.

## 2. Motivation & Context

- **Problem.** The iOS app ([[../NORTADA-OVERVIEW]]) ships with sample data and needs a real
  backend. Before any feature domain can exist, the project needs a proven, opinionated
  skeleton: layering rules, a DB access pattern, error/response envelopes, config
  validation, background-job wiring, and a test harness — all consistent so that ~9 feature
  RFCs can be built on top without re-litigating structure each time.
- **Background.** The reference backend ([[reference/brandscale-architecture]]) is a
  battle-tested Hono/Drizzle service; we adopt its layer contract, bucket rules, base
  classes, and error model wholesale. Stack decisions are recorded in [[decisions]] (D-002
  Clerk) and summarized in [[nortada-backend-decisions]].
- **Goals.**
  - A layered domain architecture with type-level and grep-level enforcement of the layer
    and bucket boundaries.
  - A DI approach that is easy to read and extend (the reference's central container was the
    one thing the team found hard to follow).
  - Cross-cutting infrastructure: typed + validated config, structured logging, a
    `GenericError` model with a Nortada-specific status map, `{ data }` / `{ error, … }`
    envelopes, an OpenAPI/Swagger surface in dev, and a Drizzle DB manager that works for
    both the HTTP process and Trigger workers.
  - `GET /health` (liveness) and `GET /health/ready` (readiness) for the platform.
- **Non-goals.** Concrete business domains (start at RFC-0002), real authentication (RFC-0002),
  real database tables (each domain adds its own), caching infrastructure (Postgres-only for
  now — no Redis, see [[../otonom-kararlar]] §2), and rate limiting (RFC-0002+).

## 3. Scope (In / Out)

- **In:** repo scaffold and `src/` layer skeleton; the `platform/foundation` domain
  (`BaseUseCase`, `BaseRepository`, exported via a barrel); `GlobalConfig` singleton with
  Zod-validated env; `DrizzleDBManager` (HTTP singleton + per-Trigger factory); the
  `error`, `logger`, `route-utils` packages; OpenAPI/Swagger (dev only); the error-handler
  middleware and placeholders for auth/rate-limit middleware; Trigger.dev config + lifecycle
  helpers; the test/lint/build toolchain; `scripts/check-import-direction.sh`; `/health` +
  `/health/ready`.
- **Out:** business domains and their tables/routes/services (RFC-0002+); the real Clerk
  integration (RFC-0002); any `pgTable` beyond the empty `dbSchema` (each domain adds its
  own).

## 4. Domain Model & Ubiquitous Language

This RFC introduces structural concepts rather than business entities:

- **Layer.** One of `route` (HTTP + validation), `service` (business logic, a `BaseUseCase`),
  `repository` (the only holder of a `dbClient` and Drizzle operators, a `BaseRepository`),
  and `drizzle` (schema + query builder). Calls flow strictly downward.
- **Bucket.** A top-level grouping under `src/domains/`: `platform/*` (the stable shared
  kernel — foundation, auth, user) vs. `feature/*` (bounded contexts that change often —
  spot, weather, activity). Allowed import directions: `feature → platform`, `feature →
  feature` (sparingly), `platform → platform`. **Forbidden: `platform → feature`.**
- **Module.** A domain's composition function `create<Domain>Module(deps)` that constructs
  its repositories (kept internal) and returns only its public services.
- **Container.** The object returned by `buildContainer(db)` — the merged public services of
  all modules, the single composition root.
- **Package.** Reusable infrastructure under `src/packages/*` (e.g. `error`, `logger`,
  `route-utils`, and later `geo`, `open-meteo`, `object-storage`). Packages are
  bucket-neutral and may be imported by any layer; they never import domains.

## 5. Data Model (Drizzle)

This RFC ships only the schema **plumbing**, not tables:

- **`src/db/schema.ts`** — the single source of truth for all tables, enums, relations, the
  aggregated `dbSchema` object, and inferred `$inferSelect` / `$inferInsert` types. At
  foundation time `dbSchema` is effectively empty; each domain RFC appends to this file.
- **Shared column helpers** (added here, used by every table): `idColumn()` (integer
  generated-always identity primary key — the internal key, never exposed), `uidColumn()`
  (text UUID with a DB default, the **public** identifier used in URLs and payloads),
  `createdAtColumn()` / `updatedAtColumn()` (`timestamptz`, precision 3). Rationale for the
  dual `id`/`uid` key: integer PKs keep joins/indexes cheap while the opaque `uid` prevents
  enumeration and decouples the public contract from row ordering.
- **`JsonValue`** type — every `jsonb` column is declared `.$type<JsonValue>()` so untyped
  `any` never leaks into the schema.
- **Units.** All stored quantities are canonical SI (m/s, m, °C); clients convert for display
  (D-006). No table here, but the rule is established now.
- **Migrations.** Generated with drizzle-kit (`npm run db:gen`) into `drizzle/`. Foundation
  establishes the pipeline; the first real migration arrives with RFC-0002.

## 6. API Surface (routes + OpenAPI)

| Method | Path            | Auth | Summary                                    |
| ------ | --------------- | ---- | ------------------------------------------ |
| GET    | `/health`       | none | Liveness — always 200, no dependencies     |
| GET    | `/health/ready` | none | Readiness — checks DB with `SELECT 1`      |
| GET    | `/openapi.json` | none | OpenAPI document (**dev only**)            |
| GET    | `/docs`         | none | Swagger UI (**dev only**)                  |

- **`GET /health`** — returns 200 unconditionally with a small `{ data }` body. It touches no
  dependency on purpose: a transient DB blip must not make an orchestrator kill an otherwise
  healthy process.
- **`GET /health/ready`** — runs `SELECT 1` through the DB manager; 200 when reachable,
  otherwise a non-200 so the platform withholds traffic until the pool is warm.
- **OpenAPI/Swagger** — produced by `hono-openapi` + `@hono/swagger-ui`, mounted only when
  `environment === "dev"` so the schema surface is never public in prod.
- **Envelopes (established here, used everywhere).** Success → `{ data }` via
  `HTTPResponse.success(data)`. Error → `{ error, reason?, message, statusCode }` via
  `HTTPResponse.error(...)`, emitted centrally by the error-handler middleware.
- **Route registration.** Centralized: `src/domains/index.ts` exposes `registerRoutes(app)`,
  and each domain mounts itself with `app.route("/v1/<domain>", <domain>Route)`. At
  foundation time the registrar is empty.

## 7. Services & Business Logic — layers and simplified DI

**Layer contract** (identical to the reference, [[reference/brandscale-architecture]] §1):
`route → service → repository → drizzle`. A **service** extends `BaseUseCase` — it has **no**
`dbClient` (it cannot touch the database by type), only `this.config`. A **repository**
extends `BaseRepository` — it owns `this.dbClient` and is the only layer permitted to use
Drizzle operators (`eq`, `and`, …) and `*Table` references. Boundaries are enforced at two
gates: (a) the type level (`BaseUseCase` simply has no DB handle), and (b) grep
(`scripts/check-import-direction.sh`, run as `npm run lint:imports`, forbids `platform →
feature` imports and DB access outside `repositories/`).

**DI simplification — domain modules instead of a central factory.** The reference keeps one
`ServiceContainer` with 40+ lazy getters (private-repo/public-service split, `??=`
memoization, `dbManager` threaded into every getter) — powerful but hard to read. Nortada
instead has each domain wire itself:

```typescript
// src/domains/feature/spot/spot.module.ts
import type { ModuleDeps } from "@/container";
export function createSpotModule({ db }: ModuleDeps) {
  const spotRepository = new SpotRepository(db);        // internal — never returned
  const spotService = new SpotService(spotRepository);  // no config arg — reads this.config
  return { spotService };                               // only public services escape
}
```

```typescript
// src/container.ts
export interface ModuleDeps { db: DBManager; }   // ONLY db; config is global via this.config

export function buildContainer(db: DBManager) {
  const deps: ModuleDeps = { db };
  const user     = createUserModule(deps);
  const spot     = createSpotModule(deps);
  const weather  = createWeatherModule({ ...deps, spotPort: spot.spotService });
  const activity = createActivityModule(deps);
  return { ...user, ...spot, ...weather, ...activity };
}
export type Container = ReturnType<typeof buildContainer>;

// HTTP singleton is LAZY so importing `@/container` is side-effect free — a Trigger
// worker can import buildContainer without triggering an HTTP-graph build.
let _container: Container | undefined;
export const getContainer = () => (_container ??= buildContainer(getDBManager()));
```

**Why this shape:** (a) no single giant wiring file — each domain owns its wiring; (b) no
private/public getter soup — repositories stay inside the module, only services are returned;
(c) cross-domain dependencies (e.g. weather → spot) are passed **explicitly and typed** at the
root as narrow ports, never fetched from a hidden global; (d) Trigger tasks build a fresh
graph with `buildContainer(taskDb)`. **Critical invariant:** `buildContainer` and every
constructor are **pure** — they touch neither `config` nor `db` at construction time (which is
why `config` is not in `ModuleDeps`; services read `this.config` at call time). This keeps
`import @/container` safe to run before `initializeApp()` / `initializeForTrigger()`.

**Base classes.**
- `BaseUseCase` — exposes `this.config` (from `GlobalConfig`); a guarded lazy `initialize()`
  pattern (`if (this._x) return;`) is available for services that memoize derived config.
- `BaseRepository` — exposes `this.dbClient` (and `this.dbManager`), bound to either the HTTP
  singleton pool or a per-task Trigger pool depending on the injected `DBManager`.

## 8. Background Jobs (Trigger.dev)

Foundation sets up Trigger.dev but ships no tasks. `trigger.config.ts` scans `./src/**/tasks`,
sets `maxDuration: 300`, and loads `.md` files. The **task pattern** every later RFC follows:
files `<name>.{schema,task,trigger}.ts`; the task body runs `initializeForTrigger()` +
`createDBManagerForTrigger()` (a per-task pool) + `buildContainer(dbManager)` inside a `try`,
and always calls `finalizeTrigger(dbManager)` in `finally`. Tasks are invoked from services,
never routes. This RFC provides only the config and the lifecycle helpers
(`initializeForTrigger` / `finalizeTrigger`); concrete tasks arrive with the domains that need
them (first one: RFC-0004 OSM ingest).

## 9. Dependencies & Integrations

- **Runtime deps:** `hono`, `hono-openapi`, `@hono/swagger-ui`, `@hono/node-server`,
  `drizzle-orm`, `pg`, `zod` (v4), `@trigger.dev/sdk`, `@clerk/backend` (wired in RFC-0002).
- **Dev deps:** `biome` (lint/format), `tsup` (build, target node22), `tsx` (dev runner),
  `jest` + `ts-jest` (+ `ts-node` for the TS jest config), `drizzle-kit`, `@types/*`.
- **Env:** declared in `src/env.d.ts` + `.env.sample`, validated by `GlobalConfig`. Naming
  convention `{NAMESPACE}_{SERVICE}_{CREDENTIAL}`. Foundation-relevant vars: `ENVIRONMENT`
  (`prod`|`dev`), `DATABASE_URL`, `AUTH_ANONYMOUS_JWT_SECRET`, `PORT`.
- **Downstream RFCs** consume `ModuleDeps`, `buildContainer`, the base classes, the error and
  route-utils packages, and the schema/DB-manager plumbing.

## 10. Security & Privacy

- **Error codes.** `UNAUTHENTICATED` (401) / `FORBIDDEN` (403) — never `UNAUTHORIZED`.
  `ALREADY_EXISTS` → **409** (a deliberate Nortada delta from the reference's 422 —
  [[../otonom-kararlar]] §1). The full `ErrorCode` union and its `statusCodeMap` live in
  `src/packages/error`.
- **`GenericError` is a pure constructor** — it performs no logging side effects. The
  error-handler middleware is the *single* place that decides what is reported vs. silent,
  so the report policy can never drift between call sites.
- **Config fail-fast.** `GlobalConfig.initialize()` parses `process.env` through a Zod schema;
  a missing/invalid var crashes at boot rather than at first request. In prod,
  `AUTH_ANONYMOUS_JWT_SECRET` must be ≥ 32 chars (a `superRefine` gate).
- **Layer isolation** is a security control, not just tidiness: DB access is confined to
  repositories at both the type level and via grep, shrinking the surface where a query can
  be built from unvalidated input.
- **CORS/transport.** `origin: *` is acceptable because this is a bearer-token mobile API with
  no cookies; `compress` is enabled. Real auth and rate limiting land in RFC-0002+.

## 11. Observability

- **Logging** via the `logger` package (`createLogger(scope)`), levels `silly|debug|info|
  warn|error`; log calls carry a structured data object. The logger adapts its formatting for
  the Trigger worker vs. the HTTP process.
- **Error reporting** is centralized in the error-handler middleware: `INTERNAL_ERROR` /
  `EXTERNAL_SERVICE_ERROR` are reported as exceptions (they should page — each is a bug or
  infra incident); expected `GenericError`s (`FORM_ERROR`, `NOT_FOUND`, `UNAUTHENTICATED`, …)
  are returned to the client without reporting. The reporting sink is `src/app/tracking.ts`.
- **Health endpoints** double as the platform's observability probes (§6).

## 12. Performance & Scalability

- **Connection pooling.** `DrizzleDBManager` owns a single `pg` pool for the HTTP process;
  Trigger tasks get their own short-lived pool via `createDBManagerForTrigger()` and release
  it in `finally`, so background work never starves the HTTP pool.
- **Lazy container.** The HTTP graph is built once on first request, keeping process start and
  module import cheap and side-effect free.
- **Stateless.** No in-process shared mutable state that would block horizontal scaling
  (rate-limiting later starts in-memory and is explicitly flagged to move to Postgres/Redis
  when the app runs multiple instances — [[../otonom-kararlar]]).

## 13. Testing Strategy

- **Runner:** Jest + ts-jest, `testMatch: **/*.spec.ts`, with `tests/setup.ts` injecting a
  mock config so services can read `this.config` under test.
- **Co-location:** each service has a sibling `<name>.service.spec.ts`; infra is mocked
  (repositories, other services, ports).
- **Foundation coverage:** the base classes, the `error` package's code→status map and pure
  construction, `HTTPResponse` envelopes, and a `buildContainer` smoke test proving the graph
  assembles without touching config/DB at import time.

## 14. Alternatives Considered

- **Central `ServiceContainer` (reference design).** Rejected as the primary DI mechanism — it
  works but the 40-getter file was the single thing the team found hardest to read. Domain
  modules keep wiring local and cross-domain edges explicit. (We kept everything else from the
  reference.)
- **Redis for caching/rate-limiting from day one.** Deferred — Postgres covers current needs;
  adding Redis now is premature infra ([[../otonom-kararlar]] §2).
- **Exposing integer PKs on the API.** Rejected in favor of the `uid` pattern to avoid
  enumeration and decouple the public contract from row identity.

## 15. Implementation Plan (checklist)

1. `npm init`; `package.json` + deps; `tsconfig*.json`, `biome.jsonc`, `tsup.config.ts`,
   `drizzle.config.ts`, `trigger.config.ts`, `jest.config.ts`.
2. `src/env.d.ts`, `.env.sample`, `src/app/global-config.ts` (guarded `initialize()` + Zod).
3. `src/db/schema.ts` (skeleton + `dbSchema` + column helpers), `src/db/db.manager.ts`
   (singleton + `createDBManagerForTrigger`), `src/db/index.ts`.
4. `src/domains/platform/foundation/` — `BaseUseCase`, `BaseRepository`, barrel.
5. `src/packages/error/` (`GenericError` + code→status map), `src/packages/route-utils/`
   (`HTTPResponse`, `successResponseSchema`), `src/packages/logger/`.
6. `src/container.ts` (`buildContainer`, `ModuleDeps`, lazy `getContainer`),
   `src/domains/index.ts` (`registerRoutes`, empty).
7. `src/app/app.ts` (contextStorage, compress, CORS, `/health`, dev `/docs`, `onError`),
   `src/app/initialize-services.ts`, `src/app/tracking.ts`, `src/index.ts`.
8. `src/middlewares/error-handler.middleware.ts` + auth-middleware placeholder.
9. `scripts/check-import-direction.sh`; lint/type/test green.

## 16. Open Questions & Resolved Decisions

- ~~`ALREADY_EXISTS` 422 vs 409~~ → **409** ([[../otonom-kararlar]] §1). ✅
- ~~Redis vs Postgres cache~~ → **Postgres**; no Redis in foundation ([[../otonom-kararlar]] §2). ✅
- ~~Deploy target~~ → **Railway** (confirmed by Berkay 2026-07-11). Code stays portable.
  [[OPEN-DECISIONS]] · [[../otonom-kararlar]] §5. ✅
- Review-driven decisions folded in: lazy `getContainer`, not injecting config, Zod env
  validation, `/health` vs `/health/ready` split, pure `GenericError` constructor, and the
  DB-access grep guard ([[../otonom-kararlar]] §6–11). ✅

## 17. References

[[reference/brandscale-architecture]] · [[decisions]] · [[nortada-backend-decisions]] ·
[[../NORTADA-OVERVIEW]]
