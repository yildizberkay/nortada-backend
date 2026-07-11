# Otonom Oturum Kararları — Berkay için inceleme notları

> Bu dosya, Berkay PC başında **değilken** (11 Tem 2026, 17:38 sonrası) RFC'leri
> otonom implemente ederken **kendi verdiğim kararları** ve **sana sormak
> istediğim açık noktaları** biriktirir. Her madde: **ne karar verdim**,
> **neden**, **hangi alternatifler vardı**, **somut örnek**, ve **geri
> dönmek istersen nereye dokunulur**. Havada bırakmıyorum — geldiğinde
> tek tek "OK / değiştir" diyebilmen için yazıldı.
>
> Statü kodları: ✅ karar verildi & uygulandı · ❓ senin onayını bekliyor ·
> ⏸️ bilinçli ertelendi.

---

## 0. Kapsam kararı — hangi RFC'ler implemente edilecek? ❓

**Karar:** Bu otonom oturumda **RFC-0001 → RFC-0006** (foundation, identity/auth,
user-profile, spot, weather, activity) **tam** implemente edilecek.
**RFC-0007 (insights), 0008 (alerts), 0009 (subscription+notification)** —
senin daha önceki kararınla `🗓️ Deferred`; bunları **implemente ETMİYORUM**,
planlama düzeyinde bırakıyorum.

**Neden:** "tüm RFC'leri implemente et" dedin ama 0007-0009'u kendi ellerinle
`Deferred` işaretledin (monetizasyon + insights + alerts = sona). İkisini
uzlaştırdım: aktif olan her şeyi bitiriyorum, senin bilinçli ertelediklerini
zorlamıyorum.

**Onayın gerekli:** Eğer 0007-0009'u da şimdi istiyorsan, geldiğinde söyle —
sıradaki oturumda eklerim. Aksi halde bunlar bir sonraki faz.

---

## 1. `ALREADY_EXISTS` → HTTP 409 (422 değil) ✅

**Karar:** `ALREADY_EXISTS` error kodu **409 Conflict** döner.

**Neden:** brandscale kodda 422 kullanmış ama kendi dökümanı 409 diyordu;
409 semantik olarak "kaynak zaten var / çakışma" için doğru olan. Bu zaten
`docs/architecture.md` ve `CLAUDE.md`'de Splash deltası olarak yazılıydı;
kod da ona uyuyor.

**Örnek:** anonim kullanıcı zaten Clerk hesabına bağlıyken tekrar `/link`
çağırırsa → `409 { error: "ALREADY_EXISTS", reason: "...", ... }`.

**Geri dönülebilir:** `src/packages/error/index.ts` `statusCodeMap`.

---

## 2. Foundation'da Redis YOK — cache Postgres tabanlı ⏸️

**Karar:** İskelete `ioredis` / Redis eklemedim. `DrizzleDBManager` sade `pg.Pool`.

**Neden:** RFC-0001 §12 açık sorusu buydu; önerim "başta Postgres, Redis sonra"
idi. Hava cache'i (D-004) P0'da bir Postgres `weather_cache` tablosu olacak
(RFC-0005), Redis operasyonel yükünü şimdi taşımak gereksiz. Tek node, tek
Postgres yeterli.

**Örnek:** brandscale `drizzle(pool, { cache: new RedisCache(redis) })` yapıyordu;
biz `drizzle(pool, { schema })` — cache yok.

**Onayın gerekli olabilir:** Ölçek büyür / hot-path okuma artarsa Redis
eklemek 1 dosyalık iş (`db.manager.ts`). Şimdilik gerek görmedim.

---

## 3. Foundation'da PostHog/analytics YOK — minimal logging stub ✅

**Karar:** brandscale'in `Tracking` (PostHog) altyapısını iskelete taşımadım.
Yerine `src/app/tracking.ts` içinde aynı arayüzü (`captureException`,
`trackErrorEvent`) sunan ama sadece structured-log basan bir stub var.
Error-handler middleware'i birebir aynı (raporlama politikası korundu).

**Neden:** PostHog projesi/anahtarı yok, ürün analitiği P0 kapsamı değil.
Arayüzü koruyorum ki ileride gerçek analytics domaini stub'ı değiştirsin,
çağrı yerleri değişmesin.

**Geri dönülebilir:** `src/app/tracking.ts` — gerçek PostHog client'ı buraya enjekte.

---

## 4. `uid` formatı — düz UUID v4, tip-önekli değil ✅

**Karar:** Her tablonun public `uid` kolonu `gen_random_uuid()` (düz UUIDv4).
`usr_...`, `spot_...` gibi tip öneki KULLANMADIM.

**Neden:** brandscale deseni bu; Zod tarafında `z.uuid()` ile doğrulaması temiz;
önek şeması ekstra üretim/parse mantığı ister, P0 faydası düşük.

**Alternatif:** Stripe-vari `spot_<uuid>` okunabilirlik/log-ayırt-edilebilirlik
sağlardı. İstersen tek noktadan (`uid` default'u) eklenebilir ama tüm
`z.uuid()` doğrulamalarını `z.string()`e çevirmek gerekir.

**Onayın gerekli olabilir:** Log'larda id tipini gözle ayırmak istiyorsan söyle.

---

## 5. Deploy hedefi — Railway varsayıldı (kod etkisi yok) ⏸️

**Karar:** Railway varsaydım (brandscale de Railway). Foundation'a `use-railway`
skill'i kurulu; ama koda özel bir bağımlılık koymadım — standart Node + Postgres.

**Neden:** RFC-0001 §12 açık sorusu; kod portable, deploy'u sonra netleştiririz.

---

## 6. Zaman damgaları `timestamptz` (UTC) ✅

**Karar:** Tüm `created_at`/`updated_at` kolonları `timestamp(..., { withTimezone: true })`
(Postgres `timestamptz`), UTC. brandscale düz `timestamp` kullanıyordu.

**Neden:** Splash global; hava tahmini ve seans zamanları farklı saat dilimlerinden
UTC olarak akıyor. `timestamptz` ofset karmaşasını kökten engeller; okuma tarafında
client dönüştürür (D-006 birim mantığıyla tutarlı).

**Geri dönülebilir:** `src/db/schema.ts` kolon yardımcıları (`createdAtColumn`/`updatedAtColumn`).

---

## 7. Composition root: LAZY `getContainer()` + config inject YOK ✅ (review-driven)

**Karar:** İki değişiklik: (a) `ModuleDeps`'ten `config` çıkarıldı — servis config'i
`this.config` (BaseUseCase) ile okur, kök'e inject edilmez. (b) HTTP singleton artık
eager `export const container = ...` değil, **lazy** `getContainer()` (`??=` memoize).

**Neden (staff-level, principal-architect review HIGH bulgusu):** Eski hâlde
`buildContainer` build anında `globalConfig.config` okuyordu ve `container` modül
yüklenince kuruluyordu. Trigger worker, task modüllerini `init`'ten **önce** import
eder → eager singleton `globalConfig.config`'e dokunup patlar, task kaydı bozulurdu.
Çözüm: `buildContainer` saf (config/db'ye dokunmaz), singleton lazy. Böylece
`@/container` import etmek yan etkisiz.

**Örnek:** RFC-0001 §6'daki güncel kod. Route/handler `getContainer().xService...`,
Trigger task `buildContainer(taskDb)`.

**Onayın gerekli değil ama bilgin olsun:** RFC şablonundaki örnek de güncellendi ki
0002+ doğru deseni kopyalasın.

---

## 8. Config: Zod ile env doğrulama / fail-fast ✅ (review-driven)

**Karar:** `GlobalConfig.initialize()` `process.env`'i bir Zod şemasından geçirir
(`ENVIRONMENT` enum, `DATABASE_URL` zorunlu, prod'da `AUTH_ANONYMOUS_JWT_SECRET` ≥32).
Geçersizse boot'ta atar.

**Neden:** `ENVIRONMENT` set değilse eski kod ne "prod" ne "dev" olan bir limbo'ya
düşüyordu (prod fail-fast'i de kapanıyordu, JWT secret doğrulanmadan boot). Zod tek
kapıda bunu imkânsız kılıyor. Zod zaten çekirdek bağımlılık.

**Geri dönülebilir:** `src/app/global-config.ts` `envSchema`.

---

## 9. `/health` (liveness) vs `/health/ready` (readiness) ayrımı ✅ (review-driven)

**Karar:** `/health` bağımlılıksız 200 döner (liveness); DB probu (`SELECT 1`)
`/health/ready`'e taşındı (readiness).

**Neden:** Eskiden `/health` DB'ye vuruyordu; bir DB blip'i liveness'ı düşürüp
gereksiz restart tetikleyebilirdi. Orkestratör (Railway/K8s) liveness≠readiness ayırır.

**Örnek:** smoke testte doğrulandı — DB yokken `/health`→200, `/health/ready`→500.

---

## 10. `GenericError` kurucusu SAF — loglama tek kaynak (middleware) ✅ (review-driven)

**Karar:** `GenericError` kurucusundaki loglama kaldırıldı. Neyin loglanacağına/
raporlanacağına **yalnız** error-handler middleware karar verir.

**Neden:** Eskiden kurucu da (kendi `criticErrors` listesiyle) loglar, middleware de
loglardı → her `INTERNAL_ERROR` iki ayrı kod listesinden çift log üretiyordu (drift
riski). Kurucu saf olmalı; construction'ın yan etkisi olmaz.

**Geri dönülebilir:** `src/packages/error/index.ts` + `src/middlewares/error-handler.middleware.ts`.

---

## 11. Logger seviye sıralaması düzeltildi + env-güdümlü eşik ✅ (review-driven)

**Karar:** `LOG_LEVELS` `silly:0 < debug:1 < info:2 < warn:3 < error:4` (eskiden
`silly:4` en yüksekti → hiç susturulamıyordu). Eşik env'den: prod→`info`, dev→`debug`.

**Neden:** Ters sıralama nedeniyle `silly` (en ayrıntılı) prod'da bile susturulamaz
haldeydi; her 4xx un-silenceable log basardı. Ayrıca middleware artık HTTPException'ları
gerçek status'uyla döner (4xx→500'e çökmez).

---

## 12. DB-erişim grep guard'ı — repository dışında yasak ✅ (review-driven)

**Karar:** `scripts/check-import-direction.sh` genişletildi: `platform↛feature`
kuralına ek olarak `drizzle-orm` operatör importu + `getDBClient`/`getDBManager`
kullanımı yalnız `**/repositories/**` (ve `BaseRepository.ts`) içinde serbest.

**Neden:** Katman izolasyonu şimdiye kadar sadece tip düzeyindeydi (`BaseUseCase`'te
`dbClient` yok); ama bir servis `getDBClient`'ı import edip repository'yi baypas
edebilirdi. Bu grep o kaçağı da kapatır (principal-architect review MEDIUM).

---

*(Sonraki RFC'lerde verilen kararlar bu dosyaya eklenmeye devam edecek.)*
