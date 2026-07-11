# RFC-0001: Proje temeli & mimari

|  |  |
|---|---|
| **RFC** | 0001 |
| **Başlık** | Proje temeli & mimari |
| **Status** | 🟡 Draft |
| **Step** | 0 |
| **Depends on** | — |
| **Domain(ler)** | platform/foundation |
| **Updated** | 2026-07-11 |

> Status lejantı: 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

## 1. Özet
Splash backend'inin çalışan iskeleti: Hono + Drizzle + Postgres + Zod + Trigger.dev + Clerk, [[reference/brandscale-architecture]] desenleriyle — ama **DI/factory sadeleştirilmiş** (kullanıcı brandscale factory'sini karışık buldu). Bu RFC katmanlı domain mimarisini, temel sınıfları, error/config/OpenAPI/DB/test/tooling altyapısını kurar. Diğer tüm RFC'ler bunun üstüne domain ekler.

## 2. Motivasyon / bağlam
Referans mimari kanıtlanmış ([[reference/brandscale-architecture]]); onu alıyoruz. Tek bilinçli sapma: merkezî dev `ServiceContainer` (40 lazy getter, private/public ayrımı, dbManager threading) yerine **domain-modül** wiring. Stack kararları [[decisions]] D-002 (Clerk), stack özeti [[splash-backend-decisions]].

## 3. Kapsam (In / Out)
**In:** repo scaffold, `src/` katman iskeleti, `foundation` domaini (BaseUseCase/BaseRepository/GenericError/HTTPResponse), config singleton, DrizzleDBManager, OpenAPI/Swagger, error-handler + auth-iskeleti middleware yerleri, Trigger config, test/lint/build tooling, `/health`.
**Out:** somut iş domainleri (auth RFC-0002'den itibaren), gerçek Clerk entegrasyonu (0002), gerçek tablolar (her domain kendi).

## 4. Veri modeli (Drizzle)
`src/db/schema.ts` — tek dosya, tüm tablolar/enum/relations + `dbSchema` export + inferred tipler. Bu RFC'de sadece iskelet: `JsonValue` tipi, boş `dbSchema = {}` (domain'ler ekler), migration pipeline (drizzle-kit). Ortak kolon deseni her tabloda: `id` (integer identity PK) + `uid` (text uuid, API'de görünen) + `createdAt`/`updatedAt`. jsonb kolonlar her zaman `.$type<JsonValue>()`.

## 5. API yüzeyi
- `GET /health` — liveness.
- Dev'de `GET /openapi.json` + `GET /docs` (Swagger UI, `hono-openapi` + `@hono/swagger-ui`).
- Route kaydı merkezî: `src/domains/index.ts` → `registerRoutes(app)`; her domain `app.route("/v1/<domain>", <domain>Route)`.
- Başarı zarfı `{ data }` (`HTTPResponse.success`), hata zarfı `{ error, reason?, message, statusCode }`.

## 6. Servisler & mantık — katmanlar ve **sadeleştirilmiş DI**

Katman kuralı (brandscale ile aynı, [[reference/brandscale-architecture]] §1): `route → service → repository → drizzle`. Service `BaseUseCase`'i extend eder (DB'ye tip olarak erişemez, sadece `this.config`); Repository `BaseRepository`'yi extend eder (`this.dbClient`). Bucket yönü `feature→platform` serbest, `platform→feature` yasak (`scripts/check-import-direction.sh`).

**DI sadeleştirmesi — merkezî factory yerine domain-modül:**

Brandscale'de tek `ServiceContainer` 40+ lazy getter tutar (private repo / public service ayrımı, `??=` memoization, `dbManager` her getter'a elle akar) — okuması zor. Yerine **her domain kendi wiring'ini bir `<domain>.module.ts`'te yapar**, kök `container.ts` bunları bağımlılık sırasına göre birleştirir:

```typescript
// src/domains/feature/spot/spot.module.ts
import type { ModuleDeps } from "@/container";
export function createSpotModule({ db, config }: ModuleDeps) {
  const spotRepository = new SpotRepository(db);      // repo domain içinde, dışarı sızmaz
  const spotService = new SpotService(spotRepository, config);
  return { spotService };                             // sadece public service'ler dışarı
}
```

```typescript
// src/container.ts
export interface ModuleDeps { db: DBManager; config: Config; /* http, clients... */ }

export function buildContainer(db: DBManager) {
  const config = globalConfig.config;
  const deps: ModuleDeps = { db, config };
  const user    = createUserModule(deps);
  const spot    = createSpotModule(deps);
  const weather = createWeatherModule(deps);
  const session = createSessionModule({ ...deps, weatherService: weather.weatherService }); // cross-domain dep AÇIK
  return { ...user, ...spot, ...weather, ...session };
}
export const container = buildContainer(getDBManager());        // HTTP singleton
export type Container = ReturnType<typeof buildContainer>;
```

Kazanç: (a) tek dev dosya yok — her domain wiring'i kendi içinde; (b) private/public getter soup yok — repo modül içinde kalır, sadece service döner; (c) cross-domain bağımlılık (session→weather) kök'te **açık ve tipli** geçer, gizli global getter yok; (d) Trigger için `buildContainer(triggerDb)` taze graf kurar. Kural: constructor'lar ağır iş yapmaz / build anında `config`/`db`'ye dokunmaz (brandscale'deki gibi). Route/middleware `import { container }`; Trigger task `buildContainer(dbManager)`.

## 7. Arka plan işleri (Trigger.dev)
`trigger.config.ts` (`dirs: ["./src/**/tasks"]`, `maxDuration: 300`, `.md` loader). Task deseni: `<name>.{schema,task,trigger}.ts`. `initializeForTrigger()` + `createDBManagerForTrigger()` + `buildContainer(dbManager)` + `finalizeTrigger()`. Bu RFC sadece config + helper'ları kurar; task'ler domain RFC'lerinde.

## 8. Bağımlılıklar & entegrasyonlar
package.json: `hono`, `hono-openapi`, `@hono/swagger-ui`, `@hono/node-server`, `drizzle-orm`, `pg`, `zod` (v4), `@trigger.dev/sdk`, `@clerk/backend`, (`ioredis` opsiyonel cache). devDeps: `biome`, `tsup`, `tsx`, `jest`+`ts-jest`, `drizzle-kit`, `@types/*`. Env `src/env.d.ts` + `.env.sample`, adlandırma `{NAMESPACE}_{SERVICE}_{CREDENTIAL}`.

## 9. Güvenlik & gizlilik
Error kodları: `UNAUTHENTICATED` (401) / `FORBIDDEN` (403), asla `UNAUTHORIZED`. `ALREADY_EXISTS` → **422 mi 409 mu bilinçli seç** (brandscale kodda 422). CORS, `compress`, rate-limit middleware yerleri. Gerçek auth 0002'de.

## 10. Test
Jest + ts-jest, `testMatch: **/*.spec.ts`, `tests/setup.ts` mock config enjekte eder. Co-location: her service'in yanında `<domain>.service.spec.ts`. Bu RFC: foundation base sınıfları + `container` build smoke test.

## 11. İmplementasyon adımları (checklist)
1. `npm init`, package.json + deps; `tsconfig*.json`, `biome.jsonc`, `tsup.config.ts`, `drizzle.config.ts`, `trigger.config.ts`, `jest.config.ts`.
2. `src/env.d.ts`, `.env.sample`, `src/app/global-config.ts` (guarded `initialize()`).
3. `src/db/schema.ts` (iskelet + `dbSchema={}`), `src/db/db.manager.ts` (DrizzleDBManager singleton + `createDBManagerForTrigger`), `src/db/index.ts`.
4. `src/domains/platform/foundation/` — `BaseUseCase`, `BaseRepository`, index.
5. `src/packages/error/` (`GenericError` + kod→status map), `src/packages/route-utils/` (`HTTPResponse`, `successResponseSchema`).
6. `src/container.ts` (`buildContainer`, `ModuleDeps`, `container`), `src/domains/index.ts` (`registerRoutes` boş).
7. `src/app/app.ts` (contextStorage, compress, cors, `/health`, dev `/docs`, `onError`), `src/app/initialize-services.ts`, `src/index.ts`.
8. `src/middlewares/error-handler.middleware.ts` + auth middleware yer tutucu.
9. `scripts/check-import-direction.sh`; lint/type/test yeşil.

## 12. Açık sorular
- `ALREADY_EXISTS` 422 vs 409 (öneri: 409, semantik olarak daha doğru — brandscale'i takip etmeyebiliriz).
- Redis cache (ioredis) P0'da gerekli mi, yoksa Postgres cache tablosu yeterli mi (hava cache D-004)? Öneri: başta Postgres, Redis sonra.
- Deploy hedefi (brandscale Railway) — muhtemelen Railway; ayrı doğrula.

## 13. Referanslar
[[reference/brandscale-architecture]] · [[decisions]] · [[splash-backend-decisions]]
