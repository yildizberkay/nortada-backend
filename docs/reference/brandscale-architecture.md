# BrandScale Backend — Architecture Digest (reusable template)

*Referans mimari. `~/dev/kodera-code-base/brandscale/brandscale-backend` projesinin domain-agnostik iskeleti çıkarıldı (2026-07-11). Splash backend'ini bu desenlerle kuracağız. Brandscale'in iş domainleri (photo, brand-dna) alakasız — kopyalanacak olan mimari/konvansiyonlar.*

Stack: Node.js + Hono (HTTP) + Drizzle ORM (Postgres/PgBouncer, `pg`) + Zod v4 + Trigger.dev + Clerk + Redis. **Modüler monolit**, katı modül sınırları grep script'iyle enforce edilir.

## 1. Katmanlar & istek akışı

Kural: **bağımlılıklar sadece içeri doğru.**

```
Route (HTTP) → Service (use case) → Repository (data access) → Drizzle → Postgres
```

| Katman | Dizin | İthal edebilir | EDEMEZ |
|---|---|---|---|
| Routes | `routes/v1.ts` | services (`container` üzerinden), schemas, middleware, `HTTPResponse` | iş mantığı, repository, Drizzle |
| Services | `services/*.service.ts` | repositories, diğer services, trigger fns, `this.config` | **Drizzle operatörleri (`eq`,`and`…), `*Table`, `this.dbClient`** |
| Repositories | `repositories/*.repository.ts` | Drizzle, `*Table`, `this.dbClient` | services, iş mantığı, URL kurma, trigger |
| Schemas | `schemas/` | Zod | stateful hiçbir şey |
| Errors | `errors.ts` | — | `as const` reason string'leri |

İki enforcement:
1. **Tip düzeyinde DB izolasyonu.** Services `BaseUseCase`'i extend eder (sadece `this.config`/`this.isDev`). Repositories `BaseRepository`'yi extend eder (ayrıca `this.dbManager`/`this.dbClient`). Service DB'ye tip olarak erişemez.
2. **Bucket yönü.** `src/domains/` altında iki bucket: `platform/*` (stabil paylaşılan çekirdek), `feature/*` (sık değişen bounded context'ler). İzin: `feature→platform`, `feature→feature` (idareli), `platform→platform`. **Yasak: `platform→feature`** — `scripts/check-import-direction.sh` (`npm run lint:imports`) ile grep'lenerek enforce edilir. `factory.ts` composition root muaf.

Bucket kuralı: bir domain `platform/` olur ancak {≥2 feature tüketiyor; cross-cutting infra/kimlik; API'si stabil} şartlarından ≥2'si sağlanırsa. Emin değilsen → `feature/`.

## 2. Domain klasör anatomisi

```
src/domains/{platform,feature}/<domain>/
├── errors.ts                     # {Domain}Reason as const
├── schemas/index.ts              # Zod request+response + z.infer tipleri
├── repositories/<domain>.repository.ts   # {Domain}Repository extends BaseRepository
├── services/<domain>.service.ts          # {Domain}Service extends BaseUseCase
├── services/<domain>.service.spec.ts      # co-located Jest unit test (ZORUNLU)
├── routes/v1.ts                  # export const <domain>Route = new Hono<HonoContext>()
├── tasks/<name>.{schema,task,trigger}.ts # (ops.) Trigger.dev 3'lü set
└── prompts/v1.md                 # (ops.)
```

İsimlendirme: Service `{Domain}Service` / `<name>.service.ts`; Repository `{Domain}Repository`; Route export `<domain>Route`; Error `{Domain}Reason`; DB tablo `<name>Table`; inferred tip PascalCase tekil (`Session`). Sınıflar PascalCase, fonksiyonlar camelCase, sabitler UPPER_SNAKE. **Her zaman named export** — sınıflar için asla `export default`. Repository'siz domain olabilir (sadece orkestrasyon yapan `onboarding` gibi); bir domainde birden çok repository olabilir (aggregate root başına bir tane + Postgres-dışı backend başına bir tane).

## 3. Routes / OpenAPI (Hono + hono-openapi + Zod)

`hono-openapi`'den `describeRoute`, `resolver`, `validator as zValidator`:

```typescript
export const sessionRoute = new Hono<HonoContext>();

sessionRoute.post(
  "/",
  describeRoute({
    operationId: "createSession",            // {verb}{Resource}
    tags: ["session"],                        // = domain adı
    responses: { 200: { description: "...", content: { "application/json": {
      schema: resolver(successResponseSchema(sessionResponseSchema)) } } } },
  }),
  authenticate,                               // middleware
  zValidator("json", createSessionSchema),    // Zod validation
  async (c) => {                              // async (c) — ASLA (c: Context)
    const user: User = c.var.user;
    const body = c.req.valid("json");         // ASLA c.req.json()
    const record = await container.sessionService.create(user, body);
    return c.json(HTTPResponse.success({ uid: record.uid }));   // { data } zarfı
  },
);
```

Kurallar: handler `async (c)` (tip verilmez, yoksa `c.req.valid` inference bozulur); kullanıcı `c.var.user`; validated input `c.req.valid(...)`; handler'da **sıfır iş mantığı** (input al → tek service çağır → `c.json(HTTPResponse.success(data))`); başarı zarfı `{ data }`. **Response schema'lar `.describe()` + `.meta({ ref: "PascalCase" })` taşımalı** (ref → OpenAPI `$ref`). Input/param schema'lar taşımaz. OpenAPI dev'de `/openapi.json` + `/docs` (swagger-ui). Route kaydı merkezî: `src/domains/index.ts` → `registerRoutes(app)` içinde `app.route("/v1/session", sessionRoute)`.

## 4. Database / Drizzle

Tek dosya `src/db/schema.ts`: tüm tablolar, enum'lar, `relations()`, `dbSchema` objesi, inferred tip alias'ları. Tablo deseni:

```typescript
export const sessionTable = pgTable("session", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  uid: text("uid").notNull().unique().default(sql`gen_random_uuid()`),  // API'de görünen opak id
  // ... camelCase TS ↔ snake_case DB
  metrics: jsonb("metrics").$type<JsonValue>(),                          // jsonb HER ZAMAN .$type
  createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull().$onUpdateFn(() => new Date()),
});
```

Her tabloda `id` (internal integer identity PK) **ve** `uid` (API'de gösterilen text uuid). En altta `export const dbSchema = { session: sessionTable, sessionRelations, ... }` + `export type Session = typeof sessionTable.$inferSelect`. **DrizzleDBManager singleton** (`src/db/db.manager.ts`): `pg.Pool` (`max:10`, PgBouncer sunucu tarafında pool'lar), `initialize()` içinde `if (this._drizzleClient) return;`. HTTP için `getDBClient()`, Trigger için `createDBManagerForTrigger()` (task başına taze pool, bitişte `reset()`). Migration drizzle-kit: schema düzenle → `npm run db:gen` → takıma haber ver (prod'da elle migrate). `drizzle/` klasörünü elle düzenleme.

## 5. Repository katmanı

Drizzle operatör/tablolarının kullanıldığı **tek yer**:

```typescript
export class SessionRepository extends BaseRepository {
  constructor(externalDBManager?: DBManager) { super(externalDBManager); }

  async findByUid(uid: string): Promise<Session | undefined> {
    return this.dbClient.query.session.findFirst({ where: eq(sessionTable.uid, uid),
      columns: { id: true, uid: true, /* sadece gerekenler */ } });
  }
  async create(values: NewSession): Promise<Session> {
    const [row] = await this.dbClient.insert(sessionTable).values(values).returning();
    return row;
  }
}
```

Kolon seçimi zorunlu. Metod adları veri erişimini anlatır (`findByX`, `create`, `updateByX`, `countX`, `listX`) — asla `getBy`/`validate`/`process` (bunlar service işi). Transaction'lar repository'de (`this.dbClient.transaction`). İstisnai-olmayan hata durumları discriminated union döner, throw etmez.

## 6. Service katmanı

İş mantığı + orkestrasyon + yetkilendirme. DB erişimi yok.

```typescript
export class SessionService extends BaseUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,   // önce repo'lar
    private readonly metricsService: MetricsService,          // sonra diğer service'ler
  ) { super(); }                                              // externalDBManager parametresi YOK

  async create(user: User, input: CreateSessionInput): Promise<Session> {
    // ... iş kuralları
    throw new GenericError("NOT_FOUND", { reason: SessionReason.NOT_FOUND, message: "..." });
  }
}
```

Config `this.config.<x>` (service'te asla `globalConfig` import etme); dev dalı `this.isDev`. `GenericError` fırlat, `reason` domain `errors.ts`'ten. Shape 1:1 uyunca DB inferred tipi doğrudan dön; farklıysa `schemas/`'te DTO. Trigger task'leri **service'ten** invoke edilir (route'tan asla).

**DI merkezî: `src/domains/factory.ts`** — `ServiceContainer`, lazy memoized getter'lar. **Repository getter'ları `private`, service getter'ları `public`.** `dbManager` sadece repo'lara akar:

```typescript
export class ServiceContainer {
  constructor(private readonly dbManager?: DBManager) {}  // yoksa HTTP singleton; varsa Trigger
  private get sessionRepo() { return (this._sessionRepo ??= new SessionRepository(this.dbManager)); }
  get sessionService() { return (this._sessionService ??= new SessionService(this.sessionRepo, this.metricsService)); }
}
export const container = new ServiceContainer();  // HTTP singleton
```

## 7. Validation (Zod v4)

`schemas/index.ts`; `z.infer` ile tip. Response'lar `.describe()` + `.meta({ ref })` taşır:

```typescript
export const createSessionSchema = z.object({ /* ... */ });
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const sessionResponseSchema = z.object({ uid: z.string(), /* ... */ })
  .describe("Session").meta({ ref: "SessionResponse" });
```

Route'ta `zValidator("json"|"param"|"query", schema)`, geri okuma `c.req.valid(...)`. Zod v4 (`z.iso.datetime()`, native `.meta()`).

## 8. Error handling

Tek `GenericError extends HTTPException`. `new GenericError(errorCode, { reason?, message?, data? })`. Kod → HTTP:

| Kod | Status |
|---|---|
| `INTERNAL_ERROR` / `EXTERNAL_SERVICE_ERROR` | 500 |
| `FORM_ERROR` | 400 |
| `UNAUTHENTICATED` | 401 (auth yok/geçersiz → "giriş yap") |
| `FORBIDDEN` | 403 (auth var ama izin yok) |
| `NOT_FOUND` | 404 |
| `ALREADY_EXISTS` | **422** (kodda; doc 409 diyor — kopyalarken bilinçli seç) |
| `CONFLICT` | 409 |
| `RATE_LIMIT_EXCEEDED` | 429 |

**`UNAUTHORIZED` yok** — `UNAUTHENTICATED` (401) ya da `FORBIDDEN` (403). Domain `errors.ts`: tek `as const` obje, değerler domain önekli UPPER_SNAKE (`SESSION_NOT_FOUND`). `app.onError(errorHandler)` GenericError'ı `{ error, reason?, message, statusCode }`'e maplar; `INTERNAL_ERROR`/`EXTERNAL_SERVICE_ERROR` → exception raporla, diğerleri sessiz. Trigger task'leri handler dışında — `catch`'te elle `Tracking.captureException`.

## 9. Config

`GlobalConfig` singleton, tipli `Config` interface (namespace'lere göre nested: `clerk`, `database`, `redis`, ...). `initialize()` içinde `if (this._config) return;`. Service/repository **`this.config`** (asla `globalConfig` import etme); sadece infra (`db.manager`, `factory`, `initialize-services`) `globalConfig.config`. Env tipleri `src/env.d.ts`. Env adı `{NAMESPACE}_{SERVICE}_{CREDENTIAL}`. `initializeApp()` bir kez `src/index.ts`'te; Trigger task'leri `run()`'ın 1. satırında `initializeForTrigger()`.

## 10. Trigger.dev task'leri

`trigger.config.ts`: `dirs: ["./src/**/tasks"]`, `maxDuration: 300`. **Task başına 3 dosya** (cycle önler; task ↔ trigger birbirini import etmez, sadece schema'yı):
- `<name>.schema.ts` — `TASK_ID` + Zod + `TaskWithSchema` tipi.
- `<name>.task.ts` — sadece orkestrasyon (`schemaTask`): `initializeForTrigger()` → `createDBManagerForTrigger()` → `new ServiceContainer(dbManager)` → `logger.trace()` adımları → `finally { finalizeTrigger(dbManager) }`.
- `<name>.trigger.ts` — enqueue fn (`tasks.trigger<T>(TASK_ID, payload)`), sadece schema'yı import eder.

Service'ten invoke edilir. Cron `schedules.task` (payload'suz, `.trigger.ts` yok). Dev `npm run trigger:dev`, deploy `npx trigger.dev@latest deploy`.

## 11. Middleware

`src/middlewares/*.middleware.ts`. Öne çıkanlar:
- **`authenticate`** — Clerk token doğrular, DB user'ı `externalId`'den bulur, `c.var.user` + `c.var.account` set eder; provision değilse `UNAUTHENTICATED`.
- **`authenticate-app-jwt`** — **login'siz app'ler için stateless JWT** → `c.var.appAuth`. *(Splash'in anonim modu için birebir uygun desen.)*
- `clerkMiddleware` (pre-provision `/bootstrap` için `c.var.clerkIdentity`), `require-role`, `require-developer`, `rate-limit`, `error-handler`.

Context tipi `src/types.ts`: `HonoContext<IsUserOptional=false>`. Authed route `new Hono<HonoContext>()`, opsiyonel-user route `new Hono<HonoContext<true>>()`. **Handler'lar header'ı doğrudan okumaz** — cross-cutting header her zaman `c.var`'a yazan bir middleware olur. App wiring `src/app/app.ts`: `contextStorage()`, `compress()`, `cors()`, `/health`, `registerRoutes`, dev `/docs`, `onError`.

## 12. Testing

Jest + ts-jest. `testMatch: ["**/*.spec.ts"]`, `clearMocks`/`restoreMocks`. **Co-location:** her service'in yanında `<name>.service.spec.ts`, saf unit test (tüm bağımlılıkları mock'la). `tests/setup.ts` mock config enjekte eder. Sınıf başına bir üst `describe`, metod başına nested, `it("should …")`, AAA. Fırlatılan hata `rejects.toMatchObject({ errorCode, options: { reason } })`. Hedef coverage: statements ≥80/branches ≥75/functions ≥85/lines ≥80.

## 13. Tooling

Node 20, ESM. Dev `tsx watch`, build `tsup`, lint **Biome** (2-space, lineWidth 80, double quote, import sırası: `node:` → external → `@/` → same-domain relative). Type check `tsc --project tsconfig.check.json`. Import yönü `scripts/check-import-direction.sh`. Path alias `@/` → `src/`; domain'ler arası `@/`, domain içi relative. Her değişiklik gate'i: `lint:biome:fix` → `lint:type` → `test` → değişen service'lere test yaz.

## 14. Yeni domain ekleme checklist'i

1. Bucket seç (`platform/` sadece stabil cross-cutting shared kernel ise; yoksa `feature/`).
2. `src/db/schema.ts` — `pgTable`/`pgEnum` + `relations`; `dbSchema`'ya ekle; `export type X = ...$inferSelect`.
3. `src/db/index.ts` — gerekli tip/enum re-export.
4. `npm run db:gen` → migration SQL; takıma haber.
5. `errors.ts` — `{Domain}Reason as const`.
6. `schemas/index.ts` — Zod request+response (response'a `.describe()`+`.meta({ref})`) + `z.infer`.
7. `repositories/<domain>.repository.ts` — `extends BaseRepository`.
8. `services/<domain>.service.ts` — `extends BaseUseCase`, deps constructor'da (repo→service).
9. `services/<domain>.service.spec.ts` — co-located unit test.
10. (ops.) `tasks/<name>.{schema,task,trigger}.ts`.
11. `routes/v1.ts` — `<domain>Route`, her route `describeRoute` + auth + `zValidator` + handler → `container.<x>Service`.
12. `factory.ts` — private repo getter + public service getter (lazy `??=`).
13. `src/domains/index.ts` — `app.route("/v1/<domain>", <domain>Route)`.
14. `lint:biome:fix && lint:type && lint:imports && test`.

## Splash için kopyalarken kararlar
- `ALREADY_EXISTS` kodda **422**, doc'ta 409 — birini bilinçli seç.
- Route validator'ı `hono-openapi`'den (`@hono/standard-validator` kurulu olsa da) — `describeRoute`/`resolver` ile tutarlılık için.
- Client hata zarfı: `{ error, reason?, message, statusCode }`; başarı zarfı: `{ data }`.
- Brandscale abonelik için **Polar** kullanıyor; biz **RevenueCat** kullanacağız (webhook + entitlement deseni benzer, SDK farklı).
