# RFC-0007: Insights

|  |  |
|---|---|
| **RFC** | 0007 |
| **Başlık** | Insights (seans birikiminden örüntüler) |
| **Status** | 🗓️ Deferred |
| **Step** | sonra (ayrı faz) |
| **Depends on** | RFC-0006 (activity) |
| **Domain(ler)** | feature/insights |
| **Updated** | 2026-07-11 |

> **Deferred** (kullanıcı kararı 2026-07-11): insights ayrı sonraki faz. Bu RFC planlama düzeyinde; tam detay ilgili faza gelince + kullanıcının uygulamadan vereceği insight listesiyle.

## 1. Özet
Tek seanstan değil, seansların **birikiminden** çıkan örüntüler: dönem özetleri (hafta/ay/sezon/yıl + önceki döneme delta), kişisel rekorlar, en hızlı koşul/spot/gear — kanıt eşikli, nedensellik iddia etmeden. App'te `AnalyticsModels` + `Insights` mantığının backend karşılığı. [[metrics-catalog]] C.

## 2. Motivasyon / bağlam
Insight'lar window-based agregasyona dayanır → veri tabanı yapısı önemli. Per-seans metrikler seans yazılırken satırda saklandığı için (RFC-0006) agregasyon ucuz.

## 3. Kapsam (In / Out)
**In:** dönem özet kartları (`SummaryMetric` × `ActivityPeriod`), rekorlar, en hızlı koşul/spot/gear (kanıt eşikleri: ör. ≥5 seans/≥3 gün; ≥2 spot×≥2 seans). Spor+hedefe göre uyarlanan kart slotları (RFC-0003 `user_sport_profile`).
**Out:** ML/tahminsel öneri; trendler (P sonra).

## 4. Veri modeli (Drizzle)
Çoğunlukla türetilir (activity satırlarından agregasyon). Gerekirse `insight_cache` (kullanıcı+dönem başına hesaplanmış kartlar, TTL). Index: activity `(userId, date, sport)`.

## 5. API yüzeyi
- `GET /v1/me/activity/summary?period=&sport=` — 4 kart + delta.
- `GET /v1/me/activity/records?sport=` — kişisel rekorlar.
- `GET /v1/me/activity/insights?sport=` — en hızlı koşul/spot/gear (yeterli veri varsa).

## 6. Servisler & mantık
`InsightsService` — dönem aralığı (current/previous) hesabı, metrik agregasyonu, kanıt eşikli örüntüler. App `Insights`/`SummaryMetric` mantığı taşınır (kanonik backend).

## 11. İmplementasyon adımları
Faz açılınca: kesin insight listesi (kullanıcıdan) → şema kararı (türet vs cache) → service+spec → routes → module.

## 13. Referanslar
[[metrics-catalog]] C · app `AnalyticsModels.swift` (Insights/ActivityPeriod)
