# Nortada Backend — Mimari & Konvansiyonlar

*Denetim referansı (convention-reviewer + principal-architect-reviewer bunu okur). Detaylı desenler [[reference/brandscale-architecture]]'da; bu belge **Nortada'ya özel kuralları ve brandscale'den bilinçli sapmaları** tanımlar. Kararların gerekçesi [[decisions]].*

## Katmanlar (brandscale ile aynı)
`route → service → repository → drizzle`. Bağımlılık sadece içeri.
- **Service** `BaseUseCase`'i extend eder — DB'ye tip olarak erişemez, sadece `this.config`.
- **Repository** `BaseRepository`'yi extend eder — Drizzle operatörleri (`eq`,`and`,`sql`…), `*Table`, `this.dbClient` **yalnızca burada**.
- **Route** iş mantığı içermez: input al (`c.req.valid`) → tek service çağır → `c.json(HTTPResponse.success(...))`.
- **Bucket'lar:** `platform/*` (stabil çekirdek) vs `feature/*`; `platform→feature` yasak (`scripts/check-import-direction.sh`).

## Nortada sapmaları (brandscale'den farkımız)

### 1. DI — merkezî mega-factory YOK, domain-modül wiring
Brandscale tek `ServiceContainer`'da 40+ lazy getter tutuyor (private repo/public service ayrımı, `dbManager` her getter'a elle akıyor) — kullanıcı bunu karışık buldu. Nortada'da:
- Her domain `<domain>.module.ts` → `create<Domain>Module(deps)`; içeride repo'yu kurar, **sadece public service'leri döner** (repo dışarı sızmaz).
- Kök `src/container.ts` → `buildContainer(db)` modülleri **bağımlılık sırasına göre** birleştirir; cross-domain bağımlılık (ör. session→weather) **açık ve tipli** geçer.
- `container = buildContainer(getDBManager())` HTTP singleton; Trigger `buildContainer(triggerDb)`.
- Kural: constructor'lar build anında ağır iş yapmaz / `config`/`db`'ye dokunmaz.
- Tam tasarım: [[rfc/0001-foundation]] §6.

### 2. `ALREADY_EXISTS` → HTTP 409
Brandscale kodda 422 kullanmış (kendi dökümanı 409 diyordu). Nortada **409** kullanır (semantik olarak doğru). Diğer kodlar aynı: `UNAUTHENTICATED`(401), `FORBIDDEN`(403), asla `UNAUTHORIZED`.

### 3. Auth çift kaynaklı
Clerk (gerçek giriş) + kendi anonim JWT'miz. Middleware ikisini de kabul eder → `c.var.user`. [[decisions]] D-002, [[rfc/0002-identity-auth]].

### 4. Birimler kanonik SI
API değerleri **m/s, metre, °C** döner; knot/km/NM/°F dönüşümü client'ta ([[decisions]] D-006). Depolama da SI. Alarm eşiği gibi girdiler client'ta temel birime çevrilip gönderilir.

## Değişmeyen brandscale kuralları (özet — detay reference'ta)
- **Routes:** `async (c)` (asla `c: Context`); `c.req.valid("json"|"param"|"query")` (asla `c.req.json()`); user `c.var.user`. Response schema `.describe()` + `.meta({ ref: "PascalCase" })`. Başarı `{ data }`, hata `{ error, reason?, message, statusCode }`. `describeRoute` → `operationId` + `tags`. Versiyon `routes/v1.ts`, mount path'te.
- **DB:** her tablo `id` (integer identity PK) + `uid` (text uuid, API'de görünen). jsonb her zaman `.$type<JsonValue>()`. Tüm tablo/enum/relations + `dbSchema` + inferred tipler `src/db/schema.ts`. `DrizzleDBManager` singleton (`pg`), guarded `initialize()`. Migration drizzle-kit (`db:gen` → elle migrate).
- **Repository:** ctor `(externalDBManager?: DBManager)` → `super()`. Zorunlu kolon seçimi. Metod adları veri-erişim (`findByX`/`create`/`updateByX`/`listX`/`countX`). Transaction repository'de.
- **Service:** `extends BaseUseCase`, ctor deps repo→service, `super()`. `this.config` (asla `globalConfig`). `GenericError` fırlat, `reason` domain `errors.ts`'ten.
- **Trigger.dev:** `<name>.{schema,task,trigger}.ts`; task `initializeForTrigger()` + `createDBManagerForTrigger()` + `buildContainer(db)` + `finally finalizeTrigger()`. Service'ten invoke.
- **Middleware:** cross-cutting header'ı handler okumaz, `c.var`'a yazan middleware olur.
- **Test:** co-located `<domain>.service.spec.ts`, tüm bağımlılıklar mock, happy+error.
- **Tooling:** Node 22 ESM, Biome (2-space, lineWidth 80, double quote, import sırası node:→external→`@/`→relative), tsup build (`target: node22`), `@/`→`src/`.

## Naming
Service `{Domain}Service`/`<name>.service.ts` · Repository `{Domain}Repository` · Route export `<domain>Route` · Error `{Domain}Reason` · Tablo `<name>Table` · inferred tip PascalCase tekil. Named export only.

## Yeni domain
[[../CLAUDE]] "Adding a New Domain — Checklist" (14 adım) — modül wiring adımı (`<domain>.module.ts` + `container.ts`) dâhil.
