# RFC-0001: Proje temeli & mimari

|  |  |
|---|---|
| **RFC** | 0001 |
| **Başlık** | Proje temeli & mimari |
| **Status** | ✅ Completed |
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
- `GET /health` — liveness (bağımlılık yok, her zaman 200 — DB blip'i restart tetiklemesin).
- `GET /health/ready` — readiness (`SELECT 1` ile DB erişilebilirliği).
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
export function createSpotModule({ db }: ModuleDeps) {
  const spotRepository = new SpotRepository(db);      // repo domain içinde, dışarı sızmaz
  const spotService = new SpotService(spotRepository); // config YOK — service `this.config` (BaseUseCase) okur
  return { spotService };                             // sadece public service'ler dışarı
}
```

```typescript
// src/container.ts
export interface ModuleDeps { db: DBManager; }   // sadece db — config global, `this.config` ile okunur

export function buildContainer(db: DBManager) {
  const deps: ModuleDeps = { db };
  const user    = createUserModule(deps);
  const spot    = createSpotModule(deps);
  const weather = createWeatherModule(deps);
  const activity = createActivityModule({ ...deps, weatherService: weather.weatherService }); // cross-domain dep AÇIK
  return { ...user, ...spot, ...weather, ...activity };
}
export type Container = ReturnType<typeof buildContainer>;

// HTTP singleton: LAZY (`getContainer()`), böylece `@/container` import'u yan
// etkisiz — Trigger worker task modüllerini init'ten önce yüklerken graf
// kurulmaz. Trigger task'i kendi grafını `buildContainer(taskDb)` ile kurar.
let _container: Container | undefined;
export const getContainer = () => (_container ??= buildContainer(getDBManager()));
```

Kazanç: (a) tek dev dosya yok — her domain wiring'i kendi içinde; (b) private/public getter soup yok — repo modül içinde kalır, sadece service döner; (c) cross-domain bağımlılık (activity→weather) kök'te **açık ve tipli** geçer, gizli global getter yok; (d) Trigger için `buildContainer(triggerDb)` taze graf kurar. Kritik kural: `buildContainer` + constructor'lar **saf** — build/import anında `config`/`db`'ye dokunmaz (bu yüzden `config` `ModuleDeps`'te yok; service `this.config` okur). Route/handler `getContainer()`; Trigger task `buildContainer(dbManager)`.

## 7. Arka plan işleri (Trigger.dev)
`trigger.config.ts` (`dirs: ["./src/**/tasks"]`, `maxDuration: 300`, `.md` loader). Task deseni: `<name>.{schema,task,trigger}.ts`. `initializeForTrigger()` + `createDBManagerForTrigger()` + `buildContainer(dbManager)` + `finalizeTrigger()`. Bu RFC sadece config + helper'ları kurar; task'ler domain RFC'lerinde.

## 8. Bağımlılıklar & entegrasyonlar
package.json: `hono`, `hono-openapi`, `@hono/swagger-ui`, `@hono/node-server`, `drizzle-orm`, `pg`, `zod` (v4), `@trigger.dev/sdk`, `@clerk/backend`, (`ioredis` opsiyonel cache). devDeps: `biome`, `tsup`, `tsx`, `jest`+`ts-jest`, `drizzle-kit`, `@types/*`. Env `src/env.d.ts` + `.env.sample`, adlandırma `{NAMESPACE}_{SERVICE}_{CREDENTIAL}`.

## 9. Güvenlik & gizlilik
Error kodları: `UNAUTHENTICATED` (401) / `FORBIDDEN` (403), asla `UNAUTHORIZED`. `ALREADY_EXISTS` → **409** (karar verildi; brandscale 422 kullanıyordu — [[../otonom-kararlar]] §1). Env doğrulaması `initialize()`'da Zod ile fail-fast (prod'da `AUTH_ANONYMOUS_JWT_SECRET` ≥32 char zorunlu). Katman izolasyonu iki kapıda: tip düzeyi (`BaseUseCase`'te `dbClient` yok) + grep (`check-import-direction.sh` DB erişimini yalnız `repositories/`'e kısar). CORS `origin:*` (bearer-token mobil API, cookie yok), `compress`. Gerçek auth + rate-limit 0002+.

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

## 12. Açık sorular → kararlar
- ~~`ALREADY_EXISTS` 422 vs 409~~ → **409** ([[../otonom-kararlar]] §1). ✅
- ~~Redis vs Postgres cache~~ → **Postgres** (foundation'da Redis yok; [[../otonom-kararlar]] §2). ✅
- Deploy hedefi (brandscale Railway) — muhtemelen Railway; kod portable, deploy sonra doğrulanacak ([[../otonom-kararlar]] §5). ⏸️
- (Review sonrası eklenen kararlar: lazy `getContainer`, config inject etmeme, Zod env doğrulama, `/health` vs `/health/ready` ayrımı, `GenericError` saf kurucu, DB-erişim grep guard'ı — hepsi [[../otonom-kararlar]] §6-11.)

## 13. Referanslar
[[reference/brandscale-architecture]] · [[decisions]] · [[splash-backend-decisions]]
