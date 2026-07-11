# RFC-0003: User & Profil

|  |  |
|---|---|
| **RFC** | 0003 |
| **Başlık** | User & Profil (profil, spor-profili, favoriler, birimler) |
| **Status** | ✅ Completed (profil + sport-profile; favoriler RFC-0004'e ertelendi) |
| **Step** | 2 |
| **Depends on** | RFC-0002 |
| **Domain(ler)** | platform/user |
| **Updated** | 2026-07-11 |

## 1. Özet
Kullanıcının uygulama-geneli kişiselleştirme durumu: global tercihler (birimler, primary sport) + **spor başına profil** (`user_sport_profile`: layout, eşikler, kart slotları) + favori spotlar. App'teki `UserProfile` + aktivite modelinin `user_sport_profile` referansının backend karşılığı.

## 2. Motivasyon / bağlam
App `UserProfile` şu an in-memory ("persistence lands with the backend"). Global vs spor-başına ayrımı: birim/primary sport global; layout/eşik/cardSlots spora özel (bir kullanıcı windsurf'te hız, SUP'ta tempo ister). [[activity-data-model]] §3 `user_sport_profile`'ı zaten referanslıyor.

## 3. Kapsam (In / Out) — **bu RFC'de sevk edilen**
**In (sevk edildi):** `user_profile` (global), `user_sport_profile` (spor başına override), profil + sport-profile CRUD. Birim politikası: değerler API'de kanonik; profil sadece **tercihi** tutar, dönüşüm client'ta (D-006). GET profil satırı yoksa `onboarded:false` ile varsayılan döner.
**Ertelendi (bilinçli, [[../otonom-kararlar]]):**
- **`favorite`** → **RFC-0004** (spot FK gerektirir; spot ile birlikte gelir).
- **`user_sport_profile` layout alanları** (enabledSections/sectionOrder/timelineLayers/defaultEquipmentId) → **RFC-0006** (activity dashboard sözlüğü orada tanımlanır).
- **`reassignOwner` (merge)** → gerçek transfer edilebilir veri (favori/aktivite) olunca; profil tercihleri branch-2'de taşınmaz (D-008).
**Out:** aktivite layout override (o `activity` üstünde, [[activity-data-model]] L3).

## 4. Veri modeli (Drizzle) — sevk edilen hâli
**`user_profile`** (global, `userId` unique) — `primarySport`, `sports[]`, `experience`, `goal`, `focus`, `activityFilter?` (null=All Sports), `cardSlots[]` (primary sport'un metrikleri — app `UserProfile.cardSlots`), `defaultActivityPeriod`, `windUnit`, `distanceUnit`, `temperatureUnit`. Birim/goal/metrik enum'ları `pgEnum` (app sözlüğünden).
**`user_sport_profile`** (spor başına override, `(userId, sport)` unique) — `sport`, `cardSlots[]?` (null→türetilmiş default), `planingThresholdMps?`, `foilingThresholdMps?` (kanonik SI m/s), `prefs jsonb`. Layout alanları RFC-0006'da eklenecek.
**`favorite`** — RFC-0004'e ertelendi (`userId`, `spotId`, unique `(userId, spotId)`).

## 5. API yüzeyi
- `GET /v1/me/profile`, `PATCH /v1/me/profile` (kısmi upsert; eşzamanlı PATCH `SELECT … FOR UPDATE` kilidiyle korunur).
- `GET /v1/me/sport-profiles`, `PUT /v1/me/sport-profiles/:sport` (tam-değişim/full-replace).
- ~~favorites~~ → RFC-0004.
- Hepsi Clerk **veya** anonim JWT (anonimin de profili olur; branch-1 merge'de korunur, D-008).

## 6. Servisler & mantık
- `UserProfileService` — get/upsert profil + spor-profili; `SummaryMetric.defaultSlots(sport, goal)` app mantığı backend'e **kanonik** taşındı; sport/goal değişince (veya ilk create) client pin'lemediyse slotlar yeniden türetilir. Primary sport'un cardSlots'u tek kaynak: sport-profile çözümü primary için `user_profile.cardSlots`'u overlay eder (iki okuma yolu tutarlı).
- `FavoriteService` — RFC-0004 (favoriler hava "sıcak set"ini besler, D-004).
- **Reassign hook** → D-008: profil tercihleri branch-2'de taşınmaz; gerçek veri (favori/aktivite) gelince transaction'lı `reassignOwner`.

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

## 12. Açık sorular → kararlar
- Onboarding ayrı domain değil: `updateProfile` upsert'i ilk profili yaratıyor; GET `onboarded` flag'i client'a "henüz onboard olunmadı"yı bildiriyor. Ayrı tablo/servis gerekmedi. ✅
- Merge reassign & favorites → RFC-0004+ ([[../otonom-kararlar]] §18, [[../decisions]] D-008). ✅

## 13. Referanslar
[[activity-data-model]] §3 · app `AnalyticsModels.swift` (UserProfile/SummaryMetric) · [[decisions]] D-006
