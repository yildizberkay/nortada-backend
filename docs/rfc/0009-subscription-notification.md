# RFC-0009: Abonelik + Notification

|  |  |
|---|---|
| **RFC** | 0009 |
| **Başlık** | Abonelik (RevenueCat) + Notification (APNs push) |
| **Status** | 🗓️ Deferred |
| **Step** | en son |
| **Depends on** | RFC-0002 (user) |
| **Domain(ler)** | platform/subscription, platform/notification |
| **Updated** | 2026-07-11 |

> **Deferred** (kullanıcı kararı 2026-07-11): monetizasyon (satış) en son, notification ile beraber. Planlama düzeyinde.

## 1. Özet
İki küçük platform yapısı. **Subscription:** RevenueCat entitlement senkronu + webhook → kullanıcının tier'ı (free/pro). **Notification:** APNs push token kaydı + gönderim (alarmlar RFC-0008 ve genel bildirimler için). İkisi birlikte "satış + bildirim" fazı.

## 2. Motivasyon / bağlam
App'te Paywall statik, pro-kilit sadece index'e göre (`index >= freeCount`); StoreKit/RevenueCat yok. Push yok. Abonelik SDK'sı RevenueCat ([[decisions]] — brandscale Polar kullanıyordu, biz RevenueCat). Değerlendirme/entitlement webhook deseni benzer.

## 3. Kapsam (In / Out)
**In:** RevenueCat webhook alıcı + entitlement → `user.subscriptionTier`; entitlement sorgu; APNs token kaydı + push gönderim servisi.
**Out:** faturalama UI (RevenueCat/StoreKit client); karmaşık kredi ledger'ı.

## 4. Veri modeli (Drizzle)
**`subscription`** — `userId`, `tier` (free|pro), `revenueCatId`, `expiresAt?`, `entitlements jsonb`, `updatedAt`.
**`push_token`** — `userId`, `token`, `platform` (ios), `environment` (sandbox|prod), `createdAt`. (`source` watch ileride.)

## 5. API yüzeyi
- `POST /v1/webhooks/revenuecat` — entitlement senkronu (imza doğrulama). Auth: webhook secret.
- `GET /v1/me/subscription` — mevcut tier.
- `POST /v1/me/push-tokens` — token kaydet. `DELETE /v1/me/push-tokens/:token`.

## 6. Servisler & mantık
`SubscriptionService` (webhook işle, tier güncelle, entitlement sorgu), `NotificationService` (`sendPush(userId, payload)` — APNs; alarmlar buradan gider).

## 7. Arka plan işleri (Trigger.dev)
Push gönderimi task olabilir (retry). Alarm-tetikli push RFC-0008'den çağrılır.

## 8. Bağımlılıklar & entegrasyonlar
RevenueCat (webhook + REST), APNs (token-based auth, `.p8` key). Env: `REVENUECAT_WEBHOOK_SECRET`, `REVENUECAT_API_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_P8`.

## 9. Güvenlik & gizlilik
Webhook imza doğrulama. Push token user-scoped. Entitlement server-side doğrulanır (client'a güvenilmez).

## 11. İmplementasyon adımları
Faz açılınca: `subscription`+`push_token` tabloları → RevenueCat webhook + `SubscriptionService` → APNs `NotificationService` → routes → module → RFC-0008 alarm push entegrasyonu.

## 13. Referanslar
app `PaywallView.swift` (statik) · [[decisions]] (RevenueCat) · [[reference/brandscale-architecture]] (webhook/subscription deseni)
