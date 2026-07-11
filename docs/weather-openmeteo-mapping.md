# Hava — Open-Meteo Mapleme

*Kullanıcının 3 katmanlı hava spec'ini (gökyüzü · karar motoru · meta) Open-Meteo'nun gerçek endpoint ve alan adlarına eşler. Alan adları/birimler ctx7 üzerinden Open-Meteo dökümanından doğrulandı (2026-07-11). Birim politikası [[decisions]] D-006: kanonik SI çek+sakla, client çevirir.*

## Endpoint'ler
- **Forecast:** `GET https://api.open-meteo.com/v1/forecast` — `forecast_days` 0–16, `hourly=`, `daily=`, `current=`, `models=`, `cell_selection=`, birim parametreleri. API key gerekmez (ticari kullanımda `apikey`).
- **Marine:** `GET https://marine-api.open-meteo.com/v1/marine` — 5 km çözünürlük, dalga + deniz değişkenleri, `forecast_days` 16'ya kadar.
- **Model metadata:** `GET https://api.open-meteo.com/v1/model-metadata?model=<model>` — model koşu/güncelleme zamanları (aşağıda, meta katmanı).

## Global istek parametreleri (hepsinde)
- `latitude`, `longitude` — spot koordinatı.
- `wind_speed_unit=ms`, `temperature_unit=celsius`, `precipitation_unit=mm` — **kanonik SI sakla** (D-06); knot/km/°F client'ta.
- `timezone` — **UTC bırak, client localize etsin** (cache paylaşımı için; local-gün agregasyonu istersek `timezone=auto`).
- `cell_selection=sea` (kıyı spotları için deniz grid hücresini tercih et; alternatif `nearest`).
- `forecast_days=11` (Spot Detail 10 günlük şerit ister → ≥11 iste).
- `models=` — otomatik `best_match` bırakılabilir; belirli model (ör. `icon_seamless`) istenirse meta katmanındaki kaynak adı netleşir.

---

## 1. Gökyüzü simülasyonu (görsel katman) → Forecast API

| İhtiyaç | Open-Meteo alanı | Blok | Birim | Not |
|---|---|---|---|---|
| WMO weather code | `weather_code` | hourly (+ current) | WMO 0–99 | 15 görsel parametrenin tamamını sürer |
| cloud_cover (opsiyonel iyileştirme) | `cloud_cover` | hourly | % | ara tonlar için; kodun kaba 0/1/2/3'ünü yumuşatır |
| lat/lon/tz | — (istek parametresi) | — | — | güneş/ay efemerisi **cihazda** hesaplanır, API'den istenmez |

`hourly=weather_code,cloud_cover` yeter. Gökyüzü için başka görsel veri gerekmiyor.

## 2. Karar motoru (Verdict · Best Window · Spot Detail · Alerts) → Forecast API, hourly, ≥10 gün

| Metrik (spec) | Open-Meteo alanı | Birim (SI) | Not |
|---|---|---|---|
| wind_speed_10m | `wind_speed_10m` | m/s | Verdict + Best Window temeli |
| wind_gusts_10m | `wind_gusts_10m` | m/s | önceki saatin maksimumu; gust spread → "gusty" |
| wind_direction_10m | `wind_direction_10m` | ° | spot shore bearing ile side/on/off-shore |
| weather_code | `weather_code` | WMO | advisory ("19:00 sonrası thunderstorm risk") |
| temperature_2m | `temperature_2m` | °C | wetsuit/konfor |
| apparent_temperature | `apparent_temperature` | °C | hissedilen |
| precipitation | `precipitation` | mm | önceki saatin toplamı |
| precipitation_probability | `precipitation_probability` | % | model bağımlı (ensemble tabanlı); standart API'de mevcut |
| cape (fırtına riski) | `cape` | J/kg | **fırtına başlamadan** risk; weather_code ancak başlayınca 95 olur |
| visibility | `visibility` | m | sis advisory; bazı modellerde var (ICON/GFS) |
| uv_index (opsiyonel) | `uv_index` | — | gün içi güvenlik notu |

Tek `hourly=` listesi: `wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,temperature_2m,apparent_temperature,precipitation,precipitation_probability,cape,visibility,uv_index`

**"Now" tick** → `current=wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,temperature_2m` (⚠ bu **model nowcast'ı**, gerçek istasyon gözlemi değil — meta katmanına bak).

### Deniz tarafı → Marine API (`/v1/marine`, hourly)

| İhtiyaç | Open-Meteo alanı | Birim | Not |
|---|---|---|---|
| wave_height | `wave_height` | m | "choppy" etiketi, SUP kararı |
| wave_period | `wave_period` | s | |
| wave_direction | `wave_direction` | ° | |
| sea_surface_temperature | `sea_surface_temperature` | °C | su sıcaklığı |
| **tide (gelgit)** | `sea_level_height_msl` | m | **✅ VAR** (gelgitler dâhil) — spec "yok" diyordu, Marine API sağlıyor |
| akıntı (bonus) | `ocean_current_velocity` / `ocean_current_direction` | km/h, ° | offshore/drift güvenlik notu için ileride |

---

## 3. Meta veriler (güven hikayesi)

| İhtiyaç | Çözüm | Durum |
|---|---|---|
| **updated_at / model koşu zamanı** | `/v1/model-metadata?model=<m>` → `last_run_initialisation_time`, `last_run_availability_time`, `update_interval_seconds` | **✅ ÇÖZÜLDÜ** — "Stale · updated 1h 20m ago" bundan + bizim `fetched_at`'ten türetilir |
| Kaynak/model adı (ICON, GFS…) | `models=` ile seçilen model + model-metadata; "Data sources" ekranında gösterilir | ✅ |
| Spot shore bearing | **bizim spot DB alanımız** (hava değil) — rüzgâr yönünü side/off-shore'a çevirir | ✅ (schema'da) |
| **Canlı istasyon gözlemi** (anlık rüzgâr/gust) | Open-Meteo **sağlamıyor** — model tabanlı, gerçek istasyon yok | ⛔ **BOŞLUK** |

### "Stale/updated" mantığı
`model-metadata` global koşu zamanını verir (istek başına değil); onu cache'leyip, kendi `fetched_at`'imizle birleştiririz. **Stale** = `now - fetched_at > update_interval` ya da model yeni koşu yapmış ama biz çekmemişiz. Trigger cron sıcak set'i (aktif alarm + favori + son görüntülenen — D-04) `update_interval` kadansıyla tazeler.

### Boşluk: "Now = gözlem, tahmin değil" vaadi
Open-Meteo'nun `current` bloğu **model nowcast**'ı; gerçek istasyon ölçümü değil. Bu ürünün "ana vaadi" olarak listelendi. Seçenekler:
- **MVP:** `current`'ı dürüstçe "model nowcast" olarak etiketle; "gözlem" iddiası yapma. (PRD zaten istasyon-güven iddiasından geri çekilmişti.)
- **Sonra:** gerçek gözlem için ayrı kaynak ekle — METAR/havaalanı (aviationweather), şamandıralar, ulusal feed'ler ya da ücretli bir gözlem API'si. Ayrı entegrasyon işi.

## Örnek istekler
```
# Forecast (karar + gökyüzü, tek çağrı)
GET /v1/forecast?latitude=40.908&longitude=29.152
  &hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,temperature_2m,apparent_temperature,precipitation,precipitation_probability,cape,visibility,uv_index,cloud_cover
  &current=wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,temperature_2m
  &wind_speed_unit=ms&temperature_unit=celsius&timezone=UTC&cell_selection=sea&forecast_days=11

# Marine (deniz)
GET /v1/marine?latitude=40.908&longitude=29.152
  &hourly=wave_height,wave_period,wave_direction,sea_surface_temperature,sea_level_height_msl&timezone=UTC&forecast_days=11

# Model metadata (tazelik)
GET /v1/model-metadata?model=icon_seamless
```

## Özet: `weather` domaini için sonuç
Tek Forecast çağrısı gökyüzü + karar motorunun tamamını karşılıyor; Marine çağrısı deniz katmanını; model-metadata tazeliği. Tek gerçek boşluk **canlı istasyon gözlemi** — MVP'de model nowcast'la dürüst etiketleme, gözlem kaynağı sonraki faz.
