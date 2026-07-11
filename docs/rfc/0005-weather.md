# RFC-0005: Hava

|  |  |
|---|---|
| **RFC** | 0005 |
| **Başlık** | Hava (Open-Meteo, decision/best-window, talep-güdümlü cache) |
| **Status** | 🟡 Draft |
| **Step** | 4 |
| **Depends on** | RFC-0004 (spot), RFC-0003 (favoriler → sıcak set) |
| **Domain(ler)** | feature/weather |
| **Updated** | 2026-07-11 |

## 1. Özet
Open-Meteo'dan spot koordinatında hava çeker, karar motorunu (decision Go/Watch/Skip, best-window, yön analizi) hesaplar, **talep-güdümlü cache**'ler ve Trigger cron'la sadece **sıcak set**'i tazeler. Gökyüzü için weather_code, deniz için Marine API. Alan mapleme: [[weather-openmeteo-mapping]]. Cache stratejisi: [[decisions]] D-004.

## 2. Motivasyon / bağlam
App şu an mock tahmin kullanıyor. Tek sağlayıcı Open-Meteo (D-003/D-004; istasyon-güven iddiası yok). "Now" tick model nowcast — gerçek gözlem sonraki faz (boşluk [[weather-openmeteo-mapping]] §3).

## 3. Kapsam (In / Out)
**In:** Open-Meteo forecast+marine+model-metadata istemcisi; conditions/forecast (bugün + 10 gün + saatlik) endpoint'leri; decision + best-window + shore-relative yön hesabı; cache tablosu + TTL; sıcak-set tazeleme cron; freshness/stale.
**Out:** gerçek istasyon gözlemi (sonra); rüzgâr vektör ızgarasının **çizimi** (client — backend sadece ızgara verisi sağlar).

## 4. Veri modeli (Drizzle)
**`weather_cache`** — `spotId` (veya `latBucket/lonBucket`), `kind` (forecast|marine), `fetchedAt`, `modelRun`, `payload jsonb` (kanonik SI, saatlik seriler), `expiresAt`. Unique `(spotId, kind)`.
**`weather_model_meta`** — `model`, `lastRunAvailabilityTime`, `updateIntervalSec`, `fetchedAt` (model-metadata cache, global).
- Best-window/decision **türetilir** (saklanmayabilir; ucuz) ya da `payload` içinde cache'lenir.

## 5. API yüzeyi
- `GET /v1/spots/:uid/conditions` — "now" + bugün özeti + verdict + best-window (RFC-0004 detay ile birleşir).
- `GET /v1/spots/:uid/forecast` — saatlik + 10 günlük şerit + yön bantları.
- `GET /v1/spots/:uid/wind-field?bbox=` — harita için rüzgâr vektör ızgarası (veri; çizim client).
- Auth: anonim JWT de erişir (login öncesi hava/spot okunmalı).

## 6. Servisler & mantık
- `OpenMeteoClient` — forecast (`wind_speed_unit=ms`, UTC, `cell_selection=sea`, `forecast_days=11`) + marine + model-metadata; SI parse.
- `WeatherService` — cache oku/getir (miss → çek + ısıt); **decision** (spor+seviye eşikleri × rüzgâr/gust/yön/weather_code); **best-window** (uygun saat aralığı); shore-relative (spot `shoreBearingDeg` → onshore/offshore/side); freshness (`modelRun` + `fetchedAt` vs `updateInterval` → stale). Eşik tabloları [[metrics-catalog]] B / PRD §12.6 (spor+seviye başına, ayarlanabilir).
- Sıcak set = favori (RFC-0003) + aktif alarm (RFC-0008) + son görüntülenen spotlar.

## 7. Arka plan işleri (Trigger.dev)
- `weather-refresh` — `schedules.task` (cron): sıcak set'i `updateInterval` kadansıyla tazele (gözlem ~10dk, tahmin ~1-3s). Global tazeleme YOK.
- `weather-model-meta-refresh` — model-metadata'yı periyodik güncelle.

## 8. Bağımlılıklar & entegrasyonlar
Open-Meteo (`api.open-meteo.com`, `marine-api.open-meteo.com`), API key gerekmez (ticaride opsiyonel). Env: `OPEN_METEO_BASE_URL`, `OPEN_METEO_MARINE_URL`. Spot (RFC-0004), favori/alarm sıcak-set için.

## 9. Güvenlik & gizlilik
Public/anonim okuma; rate-limit. Open-Meteo atıf. Kişisel veri yok.

## 10. Test
`weather.service.spec.ts` (decision eşik matrisi, best-window seçimi, shore-relative çevirim, stale mantığı, cache hit/miss), `open-meteo.client.spec.ts` (SI parse, mapleme) — HTTP mock.

## 11. İmplementasyon adımları
1. `weather_cache`+`weather_model_meta` tabloları. 2. errors/schemas. 3. `OpenMeteoClient`. 4. `weather.repository` (cache). 5. `WeatherService` (+spec) decision/best-window/shore/freshness. 6. `weather-refresh` + `weather-model-meta-refresh` task'leri. 7. routes + module + register. 8. lint/type/test.

## 12. Açık sorular
- Cache anahtarı spot-başına mı yoksa koordinat-bucket mı (yakın spotlar aynı grid hücresi paylaşabilir)? Öneri: spot-başına başla, bucket optimizasyonu sonra.
- Best-window/decision cache'lensin mi yoksa her istekte türetilsin mi? Öneri: türet (ucuz), gerekirse cache.

## 13. Referanslar
[[weather-openmeteo-mapping]] · [[decisions]] D-003/D-004 · [[metrics-catalog]] B
