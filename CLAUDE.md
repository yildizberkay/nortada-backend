# Splash Backend — Claude Instructions

Watersports decision + tracking app backend. iOS app ([[../Splash]]) is design-only; this backend replaces its sample data. Product context: `docs/SPLASH-OVERVIEW.md`.

## Stack
Node.js + Hono + Drizzle ORM + TypeScript. PostgreSQL (via `pg`). Clerk auth + our own anonymous JWT. Trigger.dev (background/cron). RevenueCat (subscriptions, last). Weather via Open-Meteo. OpenAPI/Swagger via `hono-openapi` + `@hono/swagger-ui`. Zod v4. Likely deployed on Railway.

## Before Writing Code (REQUIRED)
Read the relevant docs for the area first:
- **Architecture / conventions** → `docs/architecture.md` (Splash deltas) + `docs/reference/brandscale-architecture.md` (the detailed pattern reference we adopt).
- **The RFC you're implementing** → `docs/rfc/<NNNN>-*.md` (index: `docs/rfc/README.md`).
- **Decisions already made** → `docs/decisions.md` (D-001..).
- **Domain design docs** → `docs/activity-data-model.md`, `docs/weather-openmeteo-mapping.md`, `docs/spot-model-and-sourcing.md`, `docs/metrics-catalog.md`, `docs/research/gps-tracking.md`.

## RFC Lifecycle (REQUIRED)
- RFCs live in `docs/rfc/` as `<NNNN>-<kebab-name>.md`, format = `docs/rfc/0000-template.md`.
- Which RFC → which step: `docs/rfc/README.md`.
- Starting an RFC implementation → set its meta table `| **Status** | 🚧 In Progress |`.
- If the user requests changes that differ from the RFC → update the RFC once done.
- Completed → `| **Status** | ✅ Completed |`.

## After Every Code Change (REQUIRED)
1. `npm run lint:biome:fix` — zero lint errors before committing.
2. `npm run lint:type` — zero type errors (`tsconfig.check.json`, includes tests).
3. `npm run lint:imports` — bucket import direction (`feature→platform` OK, `platform→feature` forbidden).
4. `npm run test` — all pass.
5. **Write service tests for new/modified services** — every changed service method gets a co-located `*.service.spec.ts`. Mock all deps (repositories, other services, infra). Cover happy + error paths.
6. **Run `convention-reviewer` agent automatically** — after implementation is complete (not each step); fix what it finds without asking.
7. **Only commit when explicitly asked** — never commit proactively.
8. **Always use the `/git-commit` skill when committing** — conventional commit format.
9. End every response listing skills used (e.g. "Skills used: /drizzle-orm").

## Before Creating a PR (REQUIRED)
- **Always run `/review-principle`** — deep architectural review via `principal-architect-reviewer`.
- Ask the user before creating the PR if they haven't run it yet.

## Architecture (quick reminders — detail in `docs/architecture.md` + `docs/reference/brandscale-architecture.md`)
- **Layers:** `route → service → repository → drizzle`. Service extends `BaseUseCase` (no DB access, only `this.config`); Repository extends `BaseRepository` (`this.dbClient`). DB operators (`eq`,`and`…) and `*Table` refs ONLY in repositories.
- **DI (Splash delta):** NO central mega-factory. Each domain has `<domain>.module.ts` exporting `create<Domain>Module(deps)` returning its public services (repos stay internal). Root `src/container.ts` `buildContainer(db)` composes modules; cross-domain deps passed explicitly. See RFC-0001 §6.
- **Buckets:** `src/domains/platform/*` (stable shared kernel) vs `src/domains/feature/*` (bounded contexts). `platform→feature` forbidden (`scripts/check-import-direction.sh`).
- **Routes:** `async (c)` (never `c: Context`); `c.req.valid("json"|"param"|"query")` (never `c.req.json()`); user via `c.var.user`. Response schemas carry `.describe()` + `.meta({ ref: "PascalCase" })`. Success `{ data }`, error `{ error, reason?, message, statusCode }`.
- **DB:** every table `id` (integer identity) + `uid` (text uuid, public); jsonb always `.$type<JsonValue>()`; all tables/enums/relations + `dbSchema` + inferred types in `src/db/schema.ts`.
- **Errors:** `GenericError(code, { reason, message })`; `UNAUTHENTICATED`(401) vs `FORBIDDEN`(403), never `UNAUTHORIZED`. **`ALREADY_EXISTS` → 409 in Splash** (Splash delta; brandscale used 422).
- **Config:** services/repos use `this.config`, never `globalConfig` directly. Guarded `initialize()` (`if (this._x) return;`).
- **Trigger.dev:** `<name>.{schema,task,trigger}.ts`; task calls `initializeForTrigger()` + `createDBManagerForTrigger()` + `buildContainer(db)` + `finalizeTrigger()`; invoked from services, never routes.
- **Units:** API returns canonical SI (m/s, m, °C); client converts (D-006).

## Adding a New Domain — Checklist
1. Bucket: `platform/` only if stable cross-cutting shared kernel used by ≥2 features; else `feature/` (default).
2. `src/db/schema.ts` — `pgTable`/`pgEnum` + relations; add to `dbSchema`; `export type X = ...$inferSelect`.
3. `src/db/index.ts` — re-export new types/enums if needed.
4. `npm run db:gen` → migration; notify team (don't auto-migrate prod).
5. `domains/{bucket}/<domain>/errors.ts` — `{Domain}Reason as const`.
6. `.../schemas/index.ts` — Zod request+response (`.describe()`+`.meta({ref})` on responses).
7. `.../repositories/<domain>.repository.ts` — `extends BaseRepository`.
8. `.../services/<domain>.service.ts` — `extends BaseUseCase`, deps in constructor (repos→services).
9. `.../services/<domain>.service.spec.ts` — co-located unit test.
10. _(opt)_ `.../tasks/<name>.{schema,task,trigger}.ts`.
11. `.../routes/v1.ts` — `<domain>Route`, each route `describeRoute` + auth + `zValidator` + handler → module service.
12. `.../<domain>.module.ts` — `create<Domain>Module(deps)`; wire into `src/container.ts`.
13. `src/domains/index.ts` — `app.route("/v1/<domain>", <domain>Route)`.
14. `npm run lint:biome:fix && lint:type && lint:imports && test`.

## Reviewer agents
- `convention-reviewer` (fast, checklist, sonnet) — run after every implementation.
- `principal-architect-reviewer` (deep, opus) — run before PRs (`/review-principle`).
Slash commands: `/review-convention`, `/review-principle`.

<!-- TRIGGER.DEV SKILLS START -->
## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.claude/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-authoring-chat-agent`, `trigger-authoring-tasks`, `trigger-chat-agent-advanced`, `trigger-cost-savings`, `trigger-getting-started`, `trigger-realtime-and-frontend`.
<!-- TRIGGER.DEV SKILLS END -->
