# RFC-0008: Alarmlar

|  |  |
|---|---|
| **RFC** | 0008 |
| **Başlık** | Alarmlar (rüzgâr kuralı + değerlendirme + push) |
| **Status** | 🗓️ Deferred |
| **Step** | sonra |
| **Depends on** | RFC-0004 (spot), RFC-0005 (weather), RFC-0009 (notification/push) |
| **Domain(ler)** | feature/alert |
| **Updated** | 2026-07-11 |

> **Deferred** (kullanıcı kararı 2026-07-11): alarmlar sona bırakıldı. Planlama düzeyinde.

## 1. Özet
Kullanıcı bir spot için rüzgâr koşulu kuralı tanımlar; backend Trigger cron'uyla değerlendirir; tutunca push gönderir. Kural şeması app'te `AlertModels` (min/max wind, max gust, yönler, günler, saat aralığı, min confidence). Alarmlı spot hava "sıcak set"ine girer (D-004).

## 2. Motivasyon / bağlam
App'te kural modeli var ama değerlendirme motoru + push yok. PRD monetizasyon top-2. Değerlendirme "trigger"da (kullanıcının dediği), push APNs (RFC-0009).

## 3. Kapsam (In / Out)
**In:** `alert_rule` CRUD; değerlendirme cron; eşleşince push tetikleme + `lastFired` durumu; alarmlı spot → sıcak set.
**Out:** karmaşık ML tahmin; SMS/e-posta kanalı.

## 4. Veri modeli (Drizzle)
**`alert_rule`** — `userId`, `spotId`, `sport`, `minWind`, `maxWind`, `maxGust`, `directions[]`, `days[]` (0=Pzt..6=Paz), `startHour`, `endHour`, `minConfidence`, `isEnabled`, `lastFiredAt?`. Reassign hook (merge).

## 5. API yüzeyi
- `GET/POST /v1/me/alerts`, `PATCH/DELETE /v1/me/alerts/:uid`.

## 6. Servisler & mantık
`AlertService` (CRUD), `AlertEvaluationService` (aktif kuralları hava tahminine karşı değerlendir; pencere içinde eşleşme → push, debounce `lastFiredAt`).

## 7. Arka plan işleri (Trigger.dev)
- `alert-evaluate` — `schedules.task` (5-15dk, aktif pencereler): aktif kuralları çek → ilgili spot havasını (sıcak set) kontrol et → eşleşenlere push (RFC-0009) → `lastFiredAt`.

## 8. Bağımlılıklar
Weather (RFC-0005) tahmin/karar, Notification (RFC-0009) push, Spot (RFC-0004).

## 11. İmplementasyon adımları
Faz açılınca: `alert_rule` tablo → service+eval+spec → `alert-evaluate` task → routes → module → sıcak-set entegrasyonu.

## 13. Referanslar
app `AlertModels.swift` · [[decisions]] D-004 · PRD §10.15
