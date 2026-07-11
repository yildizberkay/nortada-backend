# Splash — Metrik Kataloğu (taslak, tartışılacak)

*Senin çerçevenle üç aile: (A) bir seans için hesaplanan metrikler, (B) hava durumu için çekilen/hesaplanan metrikler, (C) seansların toplamından çıkan insight'lar. Çoğu iOS uygulamasında zaten tanımlı — burada kaynağını da göstererek konsolide ediyorum, backend'in neyi saklayıp hesaplayacağına karar verebilelim. `Kaynak` kolonu: ham GPS'ten mi, kullanıcıdan mı, Open-Meteo'dan mı, yoksa hesaplama mı.*

---

## A. Seans metrikleri (bir seans için)

Bir seans üç tür veriden oluşur: **ham GPS track** (saklanan), **track'ten hesaplanan metrikler** (saklanan), **kullanıcı/bağlam** (girilen), ve **o ana iliştirilen hava** (çekilen).

### A.1 Ham GPS track (saklanır, blob)
Örnek başına ~1 Hz: `timestamp`, `lat`, `lon`, `speed` (doppler m/s), `course`, `horizontalAccuracy`, `speedAccuracy`. Bundan aşağıdakiler hesaplanır; harita rota hero'su ve gelecekteki yeniden-hesaplama için ham hâli de durur.

### A.2 Track'ten hesaplanan metrikler (saklanır, Postgres)

| Metrik | Ne | Kaynak | MVP? | Not |
|---|---|---|---|---|
| `distance` | toplam mesafe (km/NM) | hesap | ✅ | track uzunluğu |
| `duration` (time on water) | başlangıç→bitiş süresi | hesap | ✅ | duraklar dâhil |
| `movingTime` | hareket hâlindeki süre | hesap | ✅ | idle/drift çıkarılır |
| `maxSpeed` | filtrelenmiş en yüksek hız | hesap | ✅ | GPS spike'ları `speedAccuracy` ile atılır |
| `avgSpeed` | hareket hâlinde ortalama hız | hesap | ✅ | |
| `best10s` | en iyi kesintisiz 10 sn ortalaması | hesap | ✅ | planing benchmark'ı |
| `best5x10` | en iyi 5 (çakışmayan) 10 sn'nin ortalaması | hesap | ✅ | tek zirveden daha adil |
| **peak splits** | 2sn · 10sn · 100m · 250m · **500m** · 1NM · Alpha500 | hesap | ✅ (çek/precision notu) | speedsurfing standardı; şu an app'te sahte (`maxSpeed×katsayı`), gerçeği ham track ister |
| `planingMinutes` | planing eşiği üstünde geçen süre | hesap | ✅ | eşik spora göre (ör. windsurf ~12-14 kt) — **karar** |
| `ridingMinutes` | aktif sürüş süresi | hesap | 🔶 | tanım netleşmeli |
| `tacks` / `gybes` | dönüş sayıları | hesap | 🔶 V1.5 | course tersine dönüşlerinden; algoritma+rüzgâr yönü ister |
| `portSharePercent` | port/starboard tack dağılımı | hesap | 🔶 | course vs rüzgâr yönü |
| `bestVMG` | rüzgâra doğru en iyi "velocity made good" | hesap | ⛔ sonra | "advanced sailing module"; rüzgâr yönü+course ister |
| `avgPace` | km başına dakika (SUP/kayak) | hesap | ✅ | hız yerine tempo sporları |
| `route bbox` / özet çizgi | harita hero'su için | hesap | ✅ | ham track'ten türetilir |

> **Precision uyarısı:** iPhone 1 Hz'de 30 knot'ta ~15 m/örnek. 100m split ~6-7 örnek — kısa mesafeler kabaca çıkar. 500m ve 5×10 güvenilir; 100m'yi "yaklaşık" etiketleriz.

### A.3 Kullanıcı / bağlam (girilen)
`sport`, `gear`, `rating` (1-5), `spot`, notlar. Kullanıcıdan; seansa yazılır.

### A.4 İliştirilen hava (çekilen, forecast-vs-reality için)
Seansın olduğu yer+zamanın **gerçekleşen** rüzgârı (`windMin/Max/Avg/GustKt`, `windDirection`) ve o gün **tahmin edilmiş** olan (`forecastMin/MaxKt`). İkisinin farkı → `forecastVerdict` (Spot on / Drifted / Missed). Kaynak: B ailesi (Open-Meteo) + arşiv.

---

## B. Hava metrikleri (bir spot & zaman için)

Open-Meteo'dan çekilen ham + bizim hesapladığımız türev. Bunlar bir spot'un "bugün gidilir mi" kararını ve alarmları besler.

| Metrik | Ne | Kaynak | MVP? | Not |
|---|---|---|---|---|
| `windSpeed` / `windGust` / `windDirection` | anlık + saatlik | Open-Meteo | ✅ | çekirdek |
| saatlik zaman çizelgesi (bugün + 10 gün) | `HourlyWind[]` / `ExtendedDay[]` | Open-Meteo | ✅ | app'te `ForecastModels` |
| `waterTemp` / wetsuit notu | su sıcaklığı | Open-Meteo marine | 🔶 | app'te var |
| daylight (gün doğumu/batımı, "now") | ışık penceresi | hesap (efemeris) | ✅ | gökyüzü + best-window için |
| **`decision`** (Go / Watch / Skip) | spor+seviyeye göre karar | **hesap** | ✅ | çekirdek IP |
| **`bestWindow`** | koşulların uyduğu zaman aralığı | **hesap** | ✅ | spor+seviye rüzgâr eşikleri (ör. windsurf orta 12-22 kt) |
| `confidence` | tahmin güveni | hesap | 🔶 | model uyumu/gust yayılımı; Open-Meteo istasyon vermiyor → sade tutulacak |
| `directionBands` | tercih edilen / offshore-risk yönleri | hesap + spot metadata | ✅ | spot'un shoreline açısına göre |
| kaynak metadata | "Open-Meteo · ICON-EU · güncelleme saati" | Open-Meteo | ✅ | şeffaflık satırı |

> **Sunucu tarafı cache + Trigger.dev cron:** hava verisi spot başına çekilip cache'lenir, PRD §14.4 kadansıyla (gözlem 5-15 dk, tahmin 30-180 dk) tazelenir. Her kullanıcı isteği Open-Meteo'ya gitmez.

---

## C. Insight'lar (seansların toplamından)

Tek seanstan değil, geçmişin **birikiminden** çıkan örüntüler. App'te `AnalyticsModels` + `Insights` bunu tanımlıyor. Kanıt-eşiği var: yeterli karşılaştırılabilir seans yoksa gösterme (asla nedensellik iddia etme).

| Insight | Ne | Eşik | MVP? |
|---|---|---|---|
| **Dönem özeti** | hafta/ay/sezon/yıl için 4 kart (Volume·Duration·Performance·Frequency) + önceki döneme göre delta | — | ✅ |
| kişisel rekorlar | max hız, en iyi 5×10, en uzun mesafe... | — | ✅ |
| **en hızlı koşullar** | hangi rüzgâr yönü/aralığında en hızlısın | ≥5 seans, ≥3 gün | ✅ |
| **en hızlı spot** | ortalama zirve hızının en yüksek olduğu spot | ≥2 spot × ≥2 seans | ✅ |
| **en hızlı ekipman** | en hızlı gear setup'ı | ≥2 gear × ≥2 seans | ✅ |
| trendler | metrik başına seanslar-arası eğri | — | 🔶 |
| forecast-vs-reality özeti | tahminlerin ne kadar tuttuğu | — | 🔶 |

> Özet metrikleri spor+hedefe göre uyarlanıyor (app `SummaryMetric.defaultSlots`): ör. windsurf+hız → distance/timeOnWater/best5×10/sessions; SUP → distance/movingTime/avgPace/sessions. Birden çok spor birleşince sadece evrensel metrikler toplanır (distance/time/sessions/activeDays).

---

## Karar vermemiz gerekenler
1. **MVP metrik seti:** yukarıda ✅ olanları V1 alalım mı? 🔶'ları (tacks/gybes, port share, forecast-vs-reality trendi) V1.5, VMG'yi sonraya bırakalım mı?
2. **Eşikler:** planing eşiği ve best-window rüzgâr aralıkları spor+seviye başına tablo — PRD §12.6'daki varsayılanlarla başlayıp ayarlanabilir yapalım mı?
3. **Kanonik hesap yeri:** peak split / 5×10 / tacks backend'de mi hesaplansın (öneri: evet, Trigger task'inde — tek motor)?
4. **Birim:** depolama kanonik birimi (öneri: SI — m/s, metre — depola; sunum birimini (knot/km/NM) kullanıcı profilinden uygula).
