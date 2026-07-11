# Splash Backend — RFC Index

Bütün RFC'ler burada. Format: [`0000-template.md`](0000-template.md) (her RFC aynı iskeleti kullanır). Dosya adı `<NNNN>-<kebab-isim>.md`.

**Status lejantı:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

## İmplementasyon adımları (hangi RFC hangi step'te)

Bağımlılık sırasına göre. Her step bir öncekinin üstüne kurulur.

| Step | RFC | Başlık | Domain | Status |
|---|---|---|---|---|
| **0** | [0001](0001-foundation.md) | Proje temeli & mimari (scaffold, katmanlar, DI, error, config, OpenAPI, DB, test, tooling) | platform/foundation | ✅ Completed |
| **1** | [0002](0002-identity-auth.md) | Kimlik & Auth (anonim JWT + Clerk Apple/e-posta, dual-auth middleware, anonim→hesap merge) | platform/auth | 🟡 Draft |
| **2** | [0003](0003-user-profile.md) | User & Profil (user tablosu, user_sport_profile, birimler, favoriler) | platform/user | 🟡 Draft |
| **3** | [0004](0004-spot.md) | Spot (şema + geo nearby/search + OSM sourcing + Suggest Spot) | feature/spot | 🟡 Draft |
| **4** | [0005](0005-weather.md) | Hava (Open-Meteo forecast/marine, decision+best-window, talep-güdümlü cache + Trigger tazeleme) | feature/weather | 🟡 Draft |
| **5** | [0006](0006-activity.md) | Aktivite/Seans (4 katman, ham track upload, kanonik metrik hesabı, effort/interval/maneuver, ekipman) | feature/session | 🟡 Draft |
| _sonra_ | [0007](0007-insights.md) | Insights (seans birikiminden örüntüler, dönem özetleri) | feature/insights | 🗓️ Deferred |
| _sonra_ | [0008](0008-alerts.md) | Alarmlar (kural + değerlendirme cron + push) | feature/alert | 🗓️ Deferred |
| _en son_ | [0009](0009-subscription-notification.md) | Abonelik (RevenueCat) + Notification (APNs push) | platform/subscription, platform/notification | 🗓️ Deferred |

**Deferred (kullanıcı kararı 2026-07-11):** insights ayrı sonraki faz; alerts sona; abonelik+notification en sonda (monetizasyon en son). Bu üçünün RFC'leri iskelet/planlama düzeyinde tutulur, tam detay ilgili faza gelince.

## Bağımlılık grafiği
```
0001 foundation
  └─ 0002 auth ── 0003 user/profile
                    ├─ 0004 spot ──────┐
                    ├─ 0005 weather ───┼─ 0008 alerts (spot+weather+notification)
                    └─ 0006 activity ──┴─ 0007 insights (activity birikimi)
                                          0009 subscription + notification
```

## Kaynak dökümanlar (RFC'lerin dayandığı)
- [SPLASH-OVERVIEW](../SPLASH-OVERVIEW.md) — proje ne
- [decisions](../decisions.md) — karar log'u (D-001..D-007)
- [reference/brandscale-architecture](../reference/brandscale-architecture.md) — mimari şablon
- [activity-data-model](../activity-data-model.md) — seans veri modeli
- [weather-openmeteo-mapping](../weather-openmeteo-mapping.md) — hava alan mapleme
- [spot-model-and-sourcing](../spot-model-and-sourcing.md) — spot şema + sourcing
- [metrics-catalog](../metrics-catalog.md) — metrik aileleri
- [research/gps-tracking](../research/gps-tracking.md) — GPS upload/boyut
