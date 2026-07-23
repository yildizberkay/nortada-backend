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
>
> **⚠️ Bilinen kısıt (tüm oturum):** Docker çalışıyor ama **image registry
> erişilemez/engelli** (`hello-world` bile 10sn'de timeout) → `postgres:17-alpine`
> çekilemedi, bu yüzden hiçbir RFC'de **canlı DB testi** yapamadım. Doğrulama:
> birim testleri (jest), migration SQL incelemesi, DB'siz server-boot smoke
> (RFC-0001'de `/health`+`/openapi.json`+404+hata-zinciri doğrulandı). Sen
> gelince: `docker compose up -d db` → `npm run db:migrate` → manuel/entegrasyon
> testleri. (Registry açılırsa ben de opportunist deneyeceğim.)

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
`docs/architecture.md` ve `CLAUDE.md`'de Nortada deltası olarak yazılıydı;
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

**Neden:** Nortada global; hava tahmini ve seans zamanları farklı saat dilimlerinden
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

---

# RFC-0002 (Kimlik & Auth) kararları

## 13. Anonim JWT: uzun ömür + iss/aud + retired-row revocation ✅

**Karar:** Anonim token HS256, `sub=user.uid`, `tokenType:"anonymous"`,
`iss:"nortada-anon"`, `aud:"nortada-api"`, TTL **365 gün**. Doğrulamada alg HS256'ya
sabitli, iss+aud assert ediliyor.

**Neden:** Token cihaz Keychain'inde uzun yaşamalı (anonim kullanıcı yeniden
giriş yapmaz). Düşük yetkili (yalnız kendi verisi). iss/aud, `AUTH_ANONYMOUS_JWT_SECRET`'in
başka bir amaç için üretilmiş bir token'ının auth token'ı sanılmasını engeller
(defense-in-depth, principal-review LOW). Geniş revocation tek kaldıraç: secret
rotasyonu (tüm anonim token'ları iptal eder). Bireysel revocation: merge sonrası
`mergedIntoUserId` kontrolü her doğrulamada.

**Onayın gerekebilir:** 365 gün uzun; App Attest gelince kısaltıp yenileme
eklenebilir.

## 14. Clerk doğrulama: networkless `jwtKey` + `authorizedParties` (azp) ✅ (review-driven)

**Karar:** `verifyToken` artık `jwtKey` (varsa networkless) + `authorizedParties`
(azp) opsiyonlarını kullanıyor. Env: `CLERK_JWT_KEY`, `CLERK_AUTHORIZED_PARTIES`
(virgüllü). Ayrıca hata sınıflandırması: Clerk'in `TokenVerificationError`
reason'ı JWKS/altyapı ise **EXTERNAL_SERVICE_ERROR** (raporlanır, 5xx), token
sorunuysa **UNAUTHENTICATED** (401, sessiz).

**Neden (principal-review HIGH/MEDIUM):** (a) azp kontrolü token'ın bizim
frontend için üretildiğini doğrular; (b) `jwtKey` her isteği canlı JWKS
fetch'ine bağlamaktan kurtarır (Clerk outage'ında tüm auth çökmesin); (c) bir
Clerk outage'ının 401 "geçersiz token" gibi görünüp ops'u kör etmesi engellenir.

**Onayın gerekli:** Prod'da `CLERK_AUTHORIZED_PARTIES`'i app origin/bundle ile
doldur. Şimdilik native-only olduğu için boşken de çalışır.

**Revizyon (2026-07-15, kullanıcı kararı):** `jwtKey`/`CLERK_JWT_KEY` yolu
kaldırıldı — Clerk client'ı JWKS'i zaten process başına bir kez çekip
cache'lediği için networkless yolun getirisi marjinaldi; tek doğrulama yolu +
daha az config tercih edildi. Doğrulama artık yalnız `secretKey` ile.

## 15. Provisioning + link yarış koşulları: idempotent + fallthrough ✅ (review-driven)

**Karar:** (a) `createAnonymous`/`createClerkUser` artık `ON CONFLICT DO NOTHING`
+ re-read (cold-launch'ta paralel istekler 500 yerine tek satıra düşer). (b)
`/link` branch-1 upgrade unique çakışmasına düşerse (`tryUpgradeAnonymousToClerk`
→ null) branch-2'ye (reassign+retire) **fallthrough** eder — 500 yok.

**Neden:** iOS cold-launch'ta aynı token'la paralel istekler tipik; check-then-insert
yarışı partial-unique index'e çarpıp 500 üretiyordu (principal-review HIGH+MEDIUM).
pg 23505 bilgisi repository katmanında kapalı tutuldu (servis sızmıyor).

## 16. Retire edilen anonim satır → cihaz yeniden bootstrap edebilir ✅ (review-driven)

**Karar:** Branch-2 merge'de `markMergedInto` artık `anonymousDeviceId`'i de
**null** yapıyor; `findByAnonymousDeviceId` yalnız `mergedIntoUserId IS NULL`
(canlı) satır döner.

**Neden (principal-review HIGH):** Aksi halde kullanıcı Clerk'ten çıkıp app
anonime düşerse, retired satırın uid'iyle token üretilir ve her istek
`ANONYMOUS_TOKEN_RETIRED` ile ölür — cihaz kurtulamaz. Bu fix cihazın taze canlı
satır açmasına izin verir.

## 17. `/anonymous` + `/link` rate-limit ✅ (review-driven)

**Karar:** IP-scoped fixed-window in-memory limiter (`rateLimit`, 60sn / 20 istek)
bootstrap endpoint'lerine eklendi. Aşımda `RATE_LIMIT_EXCEEDED` (429).

**Neden:** RFC-0002 §9 rate-limit'i P0 abuse kontrolü olarak söz vermişti ama yoktu;
kimliksiz `/anonymous` sınırsız INSERT + token mint idi (principal-review HIGH).

**Onayın gerekebilir:** **In-memory → tek instance içindir.** Railway'de birden
çok instance'a çıkınca Postgres/Redis tabanlı limiter'a geçmeli (bucket paylaşımı).
Şimdilik tek instance varsayımı.

## 18. Merge'de veri taşıma — TERCİHLER taşınmaz, VERİ taşınacak ✅ (review-driven, RFC-0003'te netleşti)

**Karar:** Anonim→Clerk merge'inde:
- **Branch-1** (upgrade-in-place, aynı `user.id`) → profil/her şey **otomatik korunur** (satır aynı).
- **Branch-2** (hedefte zaten Clerk hesabı var) → anonim cihazın **profil tercihleri
  taşınMAZ**; hedef hesabın kendi profili kazanır. Anonim `user_profile` satırı
  retired user'a bağlı **ölü veri** kalır (asla sorgulanmaz — auth hep live user'a
  çözülür, `user_profile.userId` unique, FK `ON DELETE no action`). Zararsız.
- **Gerçek VERİ** (favoriler RFC-0004, aktiviteler RFC-0006) → o veri var olunca,
  merge **tek transaction** açan orkestrasyona dönecek; her domain repo'su
  `reassignOwner(fromUserId, toUserId, tx)` sunacak, `markMergedInto(tx)` ile atomik.

**Neden (iki reviewer da onayladı):** Profil = cihaz-yerel kişiselleştirme;
başka cihazda hesabı olan kullanıcı o hesabın tercihlerini devralmalı (doğru ürün
davranışı). Tercih-atmak için cross-domain transaction altyapısı kurmak erken;
kaybedilecek gerçek veri (favori/seans) olunca gerekli. Ölü satırlar ileride
retired-user GC pass'iyle temizlenebilir (küçük teknik borç, not düşüldü).
Formal ADR: [[decisions]] D-008.

**2026-07-23 refinement — ADR 0009:** Hedef profil hâlâ her çakışmayı
kazanır; ancak hedefte global profil veya belirli bir spor profili yoksa anonim
satır artık hedefe taşınır. Çakışıp kaybeden anonim tercih satırları retired
kullanıcıda ölü veri bırakmak yerine aynı merge transaction'ında silinir.

## 20. Profil GET: onboarded marker ✅ (review-driven)

**Karar:** `GET /me/profile` profil satırı yoksa varsayılanları döner ama artık
`onboarded: false` ile işaretli; satır varsa `onboarded: true`.

**Neden:** Eskiden client/insights "kullanıcı gerçekten windsurf+knots seçti" ile
"henüz onboard olmadı, bunlar tahmin" ayrımını yapamıyordu (principal-review MEDIUM).
`onboarded` bunu açık kılar; D-006 birim tercihi ancak `onboarded:true` iken gerçek
tercih sayılır. Ölü `UserReason.PROFILE_NOT_FOUND` (404 dalı) kaldırıldı.

## 21. Primary sport cardSlots tek kaynak + eşzamanlı PATCH kilidi + `Mps` ✅ (review-driven)

**Karar:** (a) `user_profile.cardSlots` (primary sport) ile `user_sport_profile.cardSlots`
(override) çift-kaynak sorunu: sport-profile çözümü artık primary sport için
`user_profile.cardSlots`'u overlay ediyor → iki okuma yolu tutarlı. (b) `updateProfile`
artık `SELECT … FOR UPDATE` ile repo-transaction içinde (eşzamanlı iki cihazın disjoint
PATCH'i birbirini ezmesin — lost-update kapandı). Sport-profile PUT tam-değişim
(full-replace) → onda lost-update yok. (c) `planing/foilingThresholdMs` → `…Mps`
(milisaniye değil, m/s hız — birim netliği, D-006).

**Neden:** Üçü de principal-architect + convention review MEDIUM/❌ bulguları.

## 19. Clerk email/displayName hydration → RFC-0003 ⏸️

**Not:** Clerk session token'ı default'ta `email` taşımaz; şu an provision'da
`email/displayName` çoğunlukla null kalıyor. RFC-0003 (profil) bunları Clerk
User API'sinden (`clerkClient.users.getUser`) veya custom JWT template claim'iyle
dolduracak. Havada bırakmıyorum — RFC-0003'ün işi.

---

---

# RFC-0004 (Spot) kararları

## 22. Merge reassign ARTIK KURULDU — favoriler ilk transfer edilen veri ✅ (review-driven, D-008 tetiklendi)

**Karar:** RFC-0004 favorileri getirdiği için D-008'in tetik koşulu doldu; merge
reassign seam'i **kurdum**. Mekanizma:
- `MergeReassigner` tipi (`src/types.ts`): `(fromUserId, toUserId, tx) => Promise<void>`.
- Her veri-sahibi domain modülü bir reassigner döndürür (spot → `favoriteReassigner`).
- Composition root (`container.ts`) bunları toplayıp `createAuthModule`'a **açıkça**
  geçer (auth feature domainini import etmez — platform↛feature korunur).
- `AuthService.linkAnonymousToClerk` branch-2 artık **tek transaction** açıyor
  (`userRepository.transaction`): önce tüm reassigner'lar (tx), sonra `markMergedInto(tx)`
  — atomik. Branch-1 (upgrade-in-place, aynı user.id) zaten her şeyi koruyor.
- `FavoriteRepository.reassignOwner` `(userId, spotId)` unique'i dedup ederek taşır
  (hedefte olan spotları önce siler, kalanı update eder).

**Neden:** principal-review HIGH — favoriler merge branch-2'de sessizce kayboluyordu.
D-008 "gerçek veri gelince transaction'lı reassign kur" diyordu; favoriler o veri.
Cross-domain transaction, `DBExecutor` (`PgDatabase<any,any,any>`) tipiyle threadleniyor
(hem client hem tx bunu sağlar). [[decisions]] D-008 güncellendi.

## 23. Diğer RFC-0004 review düzeltmeleri ✅ (review-driven)

- **ON CONFLICT partial-index:** `bulkInsertOsmPending` `onConflictDoNothing({ target: osmId, where: osm_id IS NOT NULL })` — partial unique index'i eşleştirir (aksi halde 42P10 runtime hatası; canlı DB testi olmadığı için build'de yakalanamadı — [[../otonom-kararlar]] §0).
- **Trigger reference pattern sağlamlaştırıldı:** `buildContainer` artık `try` içinde (pool leak yok); `retry: {maxAttempts:3}` + `queue: {concurrencyLimit:1}` (dış API'leri rate-limit'e karşı; her external-API task'i bunu kopyalamalı).
- **boundingBox:** enlem [-90,90] clamp + `longitudeRanges` ile antimeridian (±180) sarması → repo lon filtresi OR'lu (global mimari, RFC-0005 wind-field bunu kullanacak).
- **requireAdmin** + **OverpassClient** testleri eklendi (fail-closed authz + external-service hata dalları).
- **Favorileme** sadece `published` spot'a (add); unfavorite her statüde (kullanıcı stranded kalmasın). Suggest schema uppercase; `moderateSpotSchema`'ya country/region/locality; searchByName LIKE metachar escape.
- shoreBearing coastline-tangent otomatik türetme **P1** (küratör şimdilik elle set eder); `spot-model-and-sourcing.md` netleştirildi: `shoreBearingDeg` = kıyıdan denize bakan **dış normal** (tangent değil — türetmede 180° belirsizliği tangent→normal çevrilmeli).

---

---

# RFC-0005 (Hava) kararları

## 24. Karar motoru eşikleri = ARTIK ARAŞTIRMA-TABANLI ✅ (senin isteğinle güncellendi)

**Karar:** İlk hâli benim varsayımımdı; senin "denizcilik yüzyıllardır var, iyi
İngilizce kaynaklardan araştır" demenle **güvenilir watersports kaynaklarından**
araştırıp gerçek ideal aralıklarla güncelledim (genel/**orta seviye** için, knot):

| Spor | Çok az (skip) | **İDEAL (go)** | Çok güçlü (skip) | Kaynak notu |
|---|---|---|---|---|
| Windsurf | <10 | **12–25** | >35 | planing ~12kt'de başlar, sweet spot 15-25 |
| Wingfoil | <11 | **13–22** | >30 | pratik min 12-15, ideal 16-20 |
| Kitesurf | <10 | **12–25** | >33 | min ~12, sweet spot 15-25 |
| Sailing | <4 | **8–16** | >25 | dinghy ~20kt'de reef/kıyıya |
| SUP | — | **0–5** | >15 | düz su ≤5kt, >15 zor/tehlikeli |
| Kayak | — | **0–6** | >16 | sea kayak biraz daha toleranslı |
| Other | <4 | **8–20** | >30 | genel watersport |

Değerler m/s'ye çevrildi, `decision.ts` `THRESHOLDS`'ta (knot annotasyonları + kaynaklar comment'te).

**Kaynaklar:** windup.live (windsurf/kite knots-to-plane), mackiteboarding &
kiteworldwide (wing/kite), dinghy sailing + Beaufort rehberleri, SUP/kayak
güvenlik rehberleri (pumpedupsup, glidesup). Detay comment'te.

**Hâlâ senin girdin faydalı olur (bloklamaz):** (a) bu aralıkları kendi
deneyiminle ince ayarlamak istersen tek satır; (b) **seviye başına** bant
(başlangıç windsurfçünün tavanı 25 değil ~18kt olmalı) — bunu eklemek için
kullanıcının `experience`'ını karara threadlemek gerek (primary-sport fast-follow
ile birlikte, §27). Şimdilik orta-seviye tek tablo.

## 25. Güvenlik downgrade'leri: CAPE + offshore ölçekli ✅ (review-driven)

**Karar:** (a) **CAPE** (fırtına-öncesi enerji) motora bağlandı: >1000 J/kg →
watch, >2500 → skip — weather_code 95'e ulaşmadan (yani şimşek başlamadan) uyarır.
(b) **Offshore** downgrade güçlendirildi: pure-offshore + güçlü rüzgâr → **skip**
(denize sürüklenme, hayati risk), zayıf offshore → watch, cross-offshore → watch.

**Neden (principal-review MEDIUM, güvenlik):** Eski hâlde motor şimşek çakana
kadar "go" diyordu (CAPE fetch'leniyor ama kullanılmıyordu); offshore ise sadece
dar bantta tek-kademe idi. İkisi de can güvenliği.

## 26. Freshness: model pinlendi + stale updateInterval'dan ✅ (review-driven)

**Karar:** Forecast `models=icon_seamless`'e pinlendi ki servis ettiğimiz payload
ile okuduğumuz model-metadata **aynı modeli** anlatsın (yoksa best_match her
konumda farklı çözülüp "updated Xm ago / model run" hikâyesini tutarsız kılıyordu).
`stale` artık cache-TTL'e ek olarak `updateIntervalSec`'ten de hesaplanıyor
(now - fetchedAt > updateInterval → stale, mapping doc §3).

**Onayın gerekebilir:** icon_seamless global+EU dikişli, Ege için iyi; bölgesel
model (ICON-EU/AROME) ince ayarı ileride yapılabilir.

## 27. Weather diğer kararlar + fast-follow'lar (review-driven)

**Verilen kararlar:** TTL forecast 1s / marine 3s; sıcak set = **sadece
favoriler** (alarmlar RFC-0008, recently-viewed → P1); refresh cron */30dk;
weather→spot bağımlılığı **port** (`WeatherSpotPort`, ISP/DIP — RFC-0006 de bu
deseni izleyecek); task'lara `retry:{maxAttempts:3}` eklendi.

**Fast-follow olarak kaydedilenler (şimdilik yapılmadı, gelince):**
- **Thundering-herd:** popüler spot cache expire olunca N eşzamanlı istek N fetch
  yapıyor → in-process single-flight (spotUid,kind) eklenecek.
- **Refresh cadence-aware:** cron her 30dk TÜM favorileri yeniden çekiyor →
  cache taze olanı atla, `updateIntervalSec` kadansına uy, bounded-concurrency.
- **Primary sport:** verdict `?sport=` yoksa spot'un ilk sporuna düşüyor;
  client kullanıcının primary sport'unu `?sport=` ile geçiyor (app profili biliyor).
  Sunucu-tarafı user_profile default'u fast-follow (weather→user plumbing).
- **Daily strip UTC:** 10-günlük şerit UTC-gününe göre gruplanıyor (cache paylaşımı
  için timezone=UTC, D-006); yerel-gün hizası için client agregasyonu ya da
  timezone=auto ileride.
- **wind-field endpoint** (RFC §5) → P1 (rüzgâr vektör ızgarası; çizim client).
- Marine stale-fallback, visibility/uv_index fetch, tide/wave/apparent-temp
  response'ta yüzeye çıkarma, Open-Meteo yanıtını Zod ile doğrulama.

---

# Berkay review refinements (canlı, RFC-0006 öncesi)

## 28. Şema/isim review düzeltmeleri ✅ (Berkay geri bildirimi 2026-07-11)

Berkay dönünce şemayı gözden geçirdi; şu değişiklikleri yaptım:

1. **Tekil tablo isimleri** (`user`, `watersport_spot`, `weather_cache`…) → onaylandı,
   tavsiye edilen konvansiyon (brandscale de böyle). Değişiklik yok.
2. **`user_sport_profile.planing/foilingThresholdMps` kolonları kaldırıldı → `prefs`
   jsonb'ye taşındı.** Gerekçe (Berkay): bu eşikler yalnız bazı sporlarda anlamlı
   (SUP/kayak'ta yok) → seyrek dedicated `real` kolonlar yerine esnek jsonb bag.
   Artık `prefs: { planingThresholdMps, foilingThresholdMps, ... }`. API'de
   sport-profile = `{ cardSlots, prefs }`.
3. **`favorite` → `user_favorite`** (DB tablo adı). Gerekçe (Berkay): user'a bağlı
   şeyler `user_` önekiyle başlasın. TS var `favoriteTable` aynı kaldı (Drizzle
   TS↔DB adını ayırır).
4. **`spot` → `watersport_spot`** (DB tablo adı + index'ler). Gerekçe (Berkay):
   "spot" tek başına çok generic. Kod sembolleri (`spotTable`, `SpotService`,
   `feature/spot`, `spot_*` enum'lar) idiomatic kaldı — watersports bağlamında
   "spot" sektör terimi; tüm kod-seviyesi rename 5 RFC boyunca büyük mekanik churn,
   düşük okunabilirlik kazancı. İstersen tam kod rename'i ayrı yaparız.
5. **`OpenMeteoClient` → `WeatherProvider` interface'i.** Gerekçe (Berkay): ileride
   başka hava sağlayıcı gelirse hepsi aynı arayüze uysun (DIP). `WeatherService`
   artık concrete client'a değil `WeatherProvider`'a bağlı; `OpenMeteoClient implements
   WeatherProvider`. İkinci sağlayıcı (METAR/şamandıra) aynı arayüzü sağlar.

**Migration:** DB hiç apply edilmediği için (docker registry engelli, §0) migration'ları
tek temiz `0000`'a **konsolide ettim** (rename/drop cruft yerine final şema). Per-RFC
şema evrimi git history'de (schema.ts diff'leri) korunuyor. Gerçek deploy öncesi zaten
squash edilirdi.

# RFC-0006 (Aktivite/Seans) kararları

## 29. RFC-0006 dual-review düzeltmeleri ✅ (review-driven, 2026-07-11)

İki reviewer (convention + principal-architect) commit sonrası RFC-0006'yı denetledi.
Metrik motoru ürünün **kanonik** hız/mesafe kaynağı (D-001) olduğu için correctness'e
sert bakıldı. Bulunan + düzeltilenler:

**🔴 CRITICAL — gzip zip-bomb DoS (düzeltildi).** Upload `gunzipSync(raw)`'ı
**sınırsız + senkron** çağırıyordu → küçük bir gzip payload ~GB'a şişip process'i
OOM edebilir, üstelik senkron olduğu için event-loop'u kilitler. Tek istekle
(anonim token yeterli) prod'u düşürebilirdi. Düzeltme (`routes/v1.ts`):
1. `bodyLimit({ maxSize: 24MB })` middleware — gövde tamamı buffer'lanmadan reddedilir.
2. `gunzip` **async** + `maxOutputLength: 64MB` — şişen çıktı sınırı aşınca `RangeError`.
3. Tüm decompress+parse `try/catch` içinde → bozuk gzip artık 400 `INVALID_UPLOAD`
   (eskiden yakalanmayan 500 + ops'a captureException).

**🟠 HIGH — `avgMovingSpeed` yanlış hesaplanıyordu (düzeltildi).** `totalDistance /
movingTime` idi: pay hareketsizken (rig, gust bekleme, water-start) biriken mesafeyi
de içeriyor, payda içermiyor → boş anları olan her seansta **şişik** değer. Düzeltme
(`metrics.ts`): `movingDistance` ayrı biriktiriliyor (aynı `speed > MOVING_THRESHOLD`
kapısı altında) → `avgMovingSpeed = movingDistance / movingTime`. Regresyon testi
eklendi (idle segmentli track bugünkü kodu yakalar).

**🟠 HIGH — idempotent upload sahiplik-kontrolsüzdü (IDOR, düzeltildi).** Client-üretimi
`uid` çakışınca `createActivity` başkasının satırını (userId scope'suz) geri okuyup
üzerine yazabiliyordu → kurbanın hesabına saldırganın track'i yazılır / saldırganın
konumu kurbana sızar. Düzeltme (`activity.service.ts`): re-read sonrası
`activity.userId !== user.id` ise `ALREADY_EXISTS` (409) — çocuk insert/enqueue'dan
**önce**. UUIDv4 tahmin-edilemezliği tek savunma değil (uid URL/log'da görünür,
RFC-0006 §9 public sharing yol haritasında).

**🟠 HIGH — `processing` sonsuza kadar takılabiliyordu (düzeltildi).** Adımlar ayrı
autocommit'ti + enqueue sona bağlıydı; enqueue başarısız olursa (dev'de Trigger yok,
ya da geçici outage) retry `track var` guard'ında kısa devre yapıp **hiç enqueue
etmiyordu** → kalıcı `processing`. Düzeltme:
- L0 yazımı (track + conditions + equipment) **tek transaction**'da (`repo.ingestTrack`,
  `dbClient.transaction`) → kısmi başarısızlıkta bölünmez.
- Enqueue artık **track varlığına değil `status === "processing"`'e** bağlı → başarısız
  enqueue'lu retry kendini kurtarır. `computeAndStore` idempotent, çift-enqueue zararsız.
  `failed` statüsü kasıtlı **es geçilir** (aynı immutable track'i yeniden yüklemek
  sonucu değiştirmez; recompute ayrı seam'den — ALGORITHM_VERSION).

**🟡 MEDIUM — `maxSpeed` tek-örnek spike + `speedAccuracy` atılıyordu (düzeltildi).**
`maxSpeed` doğrudan Doppler'den geliyordu; 40 m/s altındaki tek hatalı okuma başlık
metriği olabiliyordu. `research/gps-tracking.md` `speedAccuracy`'yi "spike filtreleme
için" diye anıyordu ama ne şemada ne motorda vardı. Düzeltme (`metrics.ts` + şema):
`sAccuracy` (CoreLocation speedAccuracy) ingest ediliyor; Doppler ancak (a) accuracy
iyi (≤2 m/s) ve (b) pozisyon-türevi hız onu ≥%50 doğruluyorsa `maxSpeed`'i set edebilir,
yoksa spike-elenmiş türev kullanılır. Regresyon testi eklendi.

**🟡 Convention — repository SELECT * (düzeltildi).** Kodun `xColumns` allowlist deseni
(SpotRepository "never SELECT *") activity/equipment repolarında yoktu. Her okuyucuya
`columns:` allowlist eklendi (`activityColumns`, `activityTrackColumns`, … +
`equipmentProfileColumns`); bare `.select()`'ler relational `findMany({ columns })`'e
çevrildi. Ayrıca `trackExists` (yalnız `id`) eklendi — idempotency probe'u artık her
upload'ta 16MB `samples` blob'unu çekmiyor.

**🟡 Convention — ölü error reason (düzeltildi).** `EQUIPMENT_NOT_FOUND` hiç fırlatılmıyordu.
Ekipman-attach kasıtlı best-effort (çözülemeyen ref upload'u bozmamalı) → reason
kaldırıldı; bunun yerine `resolveEquipmentLinks` çözülemeyen ref'i `log.warn` ile
**gözlemlenebilir** kılıyor.

**Doc düzeltmeleri:** `schema.ts` yorumları (`groundSpeed`→`speed`+`sAccuracy`;
`dataVersion` gerçeğe uygun); `speedAccuracy` artık ingest edildiği için research doc
tutuyor.

### Bilinçli ERTELENENLER (P0'da kabul, senin görüşünü isteyebilir)

- **`best5x10` greedy hız-sıralı seçim optimal değil** — hızlı bir pencere, toplamı daha
  büyük iki komşu pencereyi bloke edebilir. GPS-Speedsurfing topluluk konvansiyonu +
  D-001 "resmi rekor değil" duruşu → P0'da kabul. Exact istenirse DP gerekir.
- **Effort'lar pozisyon-türevi (Doppler-entegre değil)** — 1Hz telefon GPS'inde makul;
  doppler-logger sayılarından sapma bilinen, non-official duruşla uyumlu.
- **Privacy alanları (`privacy`/`hideStart`/`hiddenRadiusM`) saklanıyor ama zorlanmıyor** —
  `detail` polyline'ı tam döndürüyor. Şimdilik zararsız (owner-scoped, public share yok);
  RFC-0006 §9 sharing gelince **zorlanmalı** (o RFC'nin işi).
- **`activity_equipment → equipment_profile` FK'da `onDelete` yok** — P0'da ekipman-silme
  endpoint'i yok. Silme gelince `RESTRICT` vs snapshot-koruma kararı verilecek.
- **Reconciliation cron yok** — status-keyed enqueue retry'da kurtarıyor, ama "N dk'dır
  `processing` + track var → yeniden enqueue" cron'u belt-and-suspenders olurdu; aynı
  zamanda RFC-0006 §7 recompute giriş noktası olur. RFC-0007/ops'a ertelendi.
- **Full-res polyline (LOD yok)** — 2 saatlik seans ~7200 nokta. `activity_route.simplified`
  LOD'ları P1 (activity-data-model.md); detail yanıt boyutu notu.
- **Aynı uid + farklı samples sessizce yok sayılır** — gerçek retry için doğru (L0
  write-once), ama divergent re-upload ayırt edilemiyor. P0'da kabul; istenirse
  content-hash ile conflict sinyali eklenir.

## 30. Ham GPS track → S3 object storage ✅ (Berkay kararı 2026-07-11)

Berkay: "dosya depolama için s3 kullanırız." RFC-0006'nın açık sorusunu (§57: "Ham
track Postgres blob mu object storage mu?") çözer. Berkay "Do it now, in RFC-0006"
seçti → jsonb yerine S3 uygulandı.

**Ne değişti:**
- **`ObjectStorage` port** (`src/packages/object-storage`) — `put/get/delete`;
  `S3ObjectStorage` adaptörü (`@aws-sdk/client-s3`, S3/R2/MinIO uyumlu:
  endpoint + forcePathStyle). Config lazy okunur (import-safe, `OpenMeteoClient`
  gibi) → `new S3ObjectStorage()` config'siz, S3 client ilk kullanımda kurulur.
- **`activity_track` şeması:** `samples jsonb` **kaldırıldı** → `storage_key text
  NOT NULL`. Satır artık yalnız pointer + `sample_count`. Migration temiz tek base'e
  yeniden generate edildi (`0000_clean_azazel`; DB hiç apply edilmedi, §0/§28 gibi).
- **Upload akışı** (`ActivityService`): samples → `gzip(JSON)` → `objectStorage.put`
  (`activities/{uid}/track.json.gz`), **DB transaction'ından ÖNCE** (external I/O tx
  içinde durmaz). Sonra `ingestTrack` `storage_key`'i yazar. Key deterministik →
  retry aynı objeyi overwrite eder (idempotent); nadir orphan (S3 yazıldı, DB
  yazılmadı) sonraki retry'da geri alınır.
- **Metrik akışı** (`ActivityMetricsService`): `findTrackByActivityId` → `storage_key`
  → `objectStorage.get` → `gunzip` → `JSON.parse` → `computeMetrics`. Trigger task
  `buildContainer` üzerinden aynı port'u alır (modülde kurulu).
- **Config:** `OBJECT_STORAGE_{BUCKET,REGION,ENDPOINT,ACCESS_KEY_ID,SECRET_ACCESS_KEY,
  FORCE_PATH_STYLE}` env. Bucket dev'de opsiyonel (S3'süz boot; adaptör kullanılırsa
  net `EXTERNAL_SERVICE_ERROR` fırlatır), **prod'da zorunlu** (env refine — hem HTTP
  upload hem Trigger read kullandığı için worker-rolünden bağımsız).
- `.env.sample` + RFC-0006 §8/§12 + activity-data-model.md güncellendi.

**⚠️ Test edilemeyen kısım (senin bilgin için):** Bu ortamda S3 bucket/credential
yok (Docker registry engelli olduğu gibi). `S3ObjectStorage` adaptörünün kendisi
**canlı entegrasyon-test edilmedi** — ince, iyi-anlaşılmış bir SDK wrapper. Servis
testleri port'u **mock'layarak** gerçek kapsama sağlıyor (upload put'u çağırıyor mu,
metrik get→gunzip→parse doğru mu). Gerçek bucket + credential bağlanınca bir kez
manuel duman-testi (upload → S3'te obje → metrik hesap) yapılmalı. Bunu senin için
not düşüyorum.

**Neden port + adaptör:** İkinci sağlayıcı (R2↔S3 geçişi) ya da presigned-URL
doğrudan-upload (iki-fazlı) ileride gelirse tek adaptör/tek metod değişir; servisler
`ObjectStorage`'a bağlı, concrete client'a değil (DIP — `WeatherProvider` deseniyle
tutarlı).

---

*(Sonraki RFC'lerde verilen kararlar bu dosyaya eklenmeye devam edecek.)*
