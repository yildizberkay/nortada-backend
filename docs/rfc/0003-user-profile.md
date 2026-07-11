# RFC-0003: User & Profil

|  |  |
|---|---|
| **RFC** | 0003 |
| **Başlık** | User & Profil (profil, spor-profili, favoriler, birimler) |
| **Status** | 🟡 Draft |
| **Step** | 2 |
| **Depends on** | RFC-0002 |
| **Domain(ler)** | platform/user |
| **Updated** | 2026-07-11 |

## 1. Özet
Kullanıcının uygulama-geneli kişiselleştirme durumu: global tercihler (birimler, primary sport) + **spor başına profil** (`user_sport_profile`: layout, eşikler, kart slotları) + favori spotlar. App'teki `UserProfile` + aktivite modelinin `user_sport_profile` referansının backend karşılığı.

## 2. Motivasyon / bağlam
App `UserProfile` şu an in-memory ("persistence lands with the backend"). Global vs spor-başına ayrımı: birim/primary sport global; layout/eşik/cardSlots spora özel (bir kullanıcı windsurf'te hız, SUP'ta tempo ister). [[activity-data-model]] §3 `user_sport_profile`'ı zaten referanslıyor.

## 3. Kapsam (In / Out)
**In:** `user_profile` (global), `user_sport_profile` (spor başına), `favorite` (spot favorileri), CRUD endpoint'leri. Birim politikası: değerler API'de kanonik; profil sadece **tercihi** tutar, dönüşüm client'ta (D-006).
**Out:** aktivite layout override (o `activity` üstünde, [[activity-data-model]] L3).

## 4. Veri modeli (Drizzle)
**`user_profile`** — `userId (unique)`, `primarySport`, `sports[]`, `experience`, `goal`, `focus`, `windUnit`, `distanceUnit`, `temperatureUnit`, `defaultActivityPeriod`.
**`user_sport_profile`** — `userId`, `sport`, `enabledSections[]`, `sectionOrder[]`, `defaultTimelineLayers[]`, `defaultEquipmentId?`, `planingThreshold`, `foilingThreshold`, `cardSlots[]` (SummaryMetric), `sportPrefs jsonb`. Unique `(userId, sport)`.
**`favorite`** — `userId`, `spotId`, `createdAt`. Unique `(userId, spotId)`.

## 5. API yüzeyi
- `GET /v1/me/profile`, `PATCH /v1/me/profile`.
- `GET /v1/me/sport-profiles`, `PUT /v1/me/sport-profiles/:sport`.
- `GET /v1/me/favorites`, `POST /v1/me/favorites` (`{spotId}`), `DELETE /v1/me/favorites/:spotId`.
- Hepsi Clerk **veya** anonim JWT (anonimin de profili/favorisi olur → merge'de taşınır).

## 6. Servisler & mantık
- `UserProfileService` — get/upsert profil + spor-profili; onboarding ilk profili yaratır (varsayılan cardSlots `SummaryMetric.defaultSlots(sport, goal)` — app mantığı backend'e taşınır).
- `FavoriteService` — add/remove/list; favoriler hava cache "sıcak set"ini besler (D-004 → weather RFC dinler).
- **Reassign hook** (RFC-0002 merge): `reassignOwner(from,to,tx)` — profil (hedefte varsa anonimi at, yoksa taşı), sport-profiller, favoriler (dedupe).

## 7. Arka plan işleri
Yok.

## 8. Bağımlılıklar & entegrasyonlar
RFC-0002 (user). Spot varlığı (favorite → spot FK) RFC-0004; sıralama: user profili spot'tan önce kurulabilir, favorite kısmı spot gelince aktif.

## 9. Güvenlik & gizlilik
Hepsi `c.var.user` scoped; başka kullanıcının profiline erişim yok. PII: email/displayName Clerk'te asıl; burada minimum.

## 10. Test
`user-profile.service.spec.ts` (upsert, default cardSlots türetme, reassign merge), `favorite.service.spec.ts` (add/remove/dedupe, reassign).

## 11. İmplementasyon adımları
1. 3 tablo (schema+dbSchema+type). 2. `user/errors.ts`, `schemas/`. 3. repositories (profile, sportProfile, favorite) + reassign metotları. 4. services (+spec). 5. `user.module.ts`, routes `/v1/me/*`. 6. lint/type/test.

## 12. Açık sorular
- Onboarding'i ayrı domain mi yoksa user içinde bir servis mi? (öneri: user içinde `OnboardingService`, ayrı tablo gerekmez.)

## 13. Referanslar
[[activity-data-model]] §3 · app `AnalyticsModels.swift` (UserProfile/SummaryMetric) · [[decisions]] D-006
