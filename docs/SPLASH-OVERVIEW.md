# Splash — Proje Genel Bakış (backend öncesi ortak anlayış)

*`~/dev/personal/splash/` altındaki tüm parçalar incelenerek çıkarıldı — PRD + iOS kaynak kodunun derinlemesine okunması (11 Temmuz 2026). Amaç: backend ihtiyaçlarını belirlemeden önce uygulamayı tam anlamak.*

## 1. Splash nedir?

Splash, **rüzgâr/su sporlarıyla uğraşan insanlar için bir uygulama** — rüzgâr sörfü, yelken, wingfoil (ileride kitesurf, SUP, kayak). İki işi bir arada yapar:

1. **Karar verdirir** — suya çıkmadan önce "bugün nereye, ne zaman gideyim, koşullar benim sporum/seviyem için iyi mi riskli mi?" Bu, su sporcusuna özel bir hava durumu deneyimi: genel bir hava uygulaması değil, spot + rüzgâr + gust odaklı.
2. **Seansı kaydeder ve öğretir** — sudayken telefonla (ileride Apple Watch'la) kendini track edersin: en iyi hız (knot), mesafe, hız grafiği, 500m'deki en iyi hız gibi speedsurfing metrikleri. Sonra geçmişinden ne zaman/nerede/hangi ekipmanla daha hızlı olduğunu öğrenirsin.

Temel vaat (PRD): *"Suya çıkmadan önce Splash sana nereye gideceğini, ne zaman gideceğini, rüzgâr verisinin ne kadar güvenilir olduğunu ve koşulların neden iyi ya da riskli olduğunu söyler."*

### Kullanıcının bakışıyla ana akışlar

- **Hava/karar ekranı** — su sporcusuna özel, canlı gökyüzü arka planlı (Today).
- **Spot bulma** — haritadan yelken yapılabilecek yerleri/portları ara; anlık rüzgâr ve gust'a bak.
- **Tracking** — suda kendini kaydet; hız/mesafe/grafik/peak split'ler. "Basit değil" — speedsurfing analitiği (2sn, 10sn, 100/250/500m, 1NM, Alpha 500, ileride VMG).
- **Kimlik** — **anonim devam edilebilir** ya da **giriş yapıp geçmişi/verisi kaydedilebilir**. *(Kullanıcının açıkça vurguladığı gereksinim — bkz. §4, kodda henüz yok.)*
- **Apple Watch** — saatten veri toplama. *(Kullanıcının beklentisi; PRD'de V2, kodda henüz yok.)*

### Splash ne DEĞİLDİR (v1)

Waterspeed klonu değil, "su sporları Strava'sı" değil, sosyal ağ değil, yarış analitiği paketi değil, 30 sporluk genel tracker değil. İlk giriş noktası performans değil, **spot'a özel rüzgâr istihb, sonra tracking**.

## 2. Depo yapısı

```
~/dev/personal/splash/
├── Splash/           # Native iOS uygulaması (SwiftUI + SwiftData) — kendi git repo'su
├── splash-design/    # PRD v0.2 (~3100 satır) + HTML mock'lar  ⚠ kod v0.3'ü takip ediyor (aşağıda)
├── splash-backend/   # Backend — BOŞ, yazılacak olan (bu proje)
└── weather-sim/      # WebGL2 hava simülasyonu → iOS'taki Metal gökyüzünün kaynağı
```

## 3. iOS uygulaması — bugün gerçekte ne var?

Beş sekmeli kabuk (`RootTabView`): **Today · Spots · Track · Activity · Profile**. Alerts artık sekme değil, gömülü. UI olgun; kod tabanı düşünülerek yazılmış (zengin modeller, isabetli yorumlar). **Ama sunucu-şekilli her şey taklit/in-memory** — kod yorumları bunu defalarca "gerçek backend gelince" diye erteliyor.

### Gerçek vs. taklit tablosu (backend kapsamı için en kritik bölüm)

| Alan | Durum | Kanıt |
|---|---|---|
| Oturum kaydı (`SessionRecord`) | **Gerçek, kalıcı** — SwiftData, cihazda | `Models.swift:222`; finish'te `context.insert/save` |
| Spot verisi | **Taklit** — `SampleData` sabitleri; model zaten "backend-fed later" işaretli | `Models.swift:40,90` |
| Tahmin/koşullar (10 günlük, saatlik, yön analizi) | **Taklit** — deterministik mock eğriler | `ForecastModels.swift:182`, `tenDayOutlook` |
| Canlı gökyüzü (Metal) | **Gerçek ama offline** — WMO kodu+konum+saat girişi; konum İstanbul'a sabitlenmiş | `WeatherSkyEngine.swift:236`, `TodayView.swift:219` "stubbed" |
| **Canlı GPS tracking** | **YOK — tamamen simüle** | `CLLocationManager` hiç yok; `LiveTrackingView.swift:21,25` sabit `sampleTrack` + sabit metrikler |
| Peak split'ler (500m vb.), VMG | **Türetilmiş, gerçek değil** — `maxSpeed × katsayı`; VMG `nil` | `Models.swift:289` "until real GPS analysis lands" |
| **Auth / anonim vs. login** | **YOK** — hiç kimlik, token, hesap kavramı yok | AuthenticationServices import edilmiyor; Plan "Splash Pro" sabit metin |
| Alarmlar (rüzgâr) | Model var; **değerlendirme motoru + push YOK**, in-memory | `AlertModels.swift:31` (kural şeması) / `:112` in-memory; UNUserNotification yok |
| Abonelik (Paywall) | **Statik UI** — StoreKit yok; pro-kilit sadece index'e göre | `PaywallView.swift:10,171`; `SpotDetailView.swift:760` `index >= freeCount` |
| Apple Watch / HealthKit | **YOK** — hiçbir import, watch target yok | — |
| Networking / API | **YOK** — hiç URLSession/endpoint yok, her şey local | — |
| Profil, favoriler, alarm kalıcılığı | **In-memory** — her açılışta sıfırlanır | `UserProfile`/`AlertsStore` `@Observable`; favoriler `@State`, kaydedilmiyor |

**Kalıcı olan tek şey:** oturum kayıtları (SwiftData) + birkaç `@AppStorage` flag (onboard edildi mi, bildirim toggle'ı). Geri kalan her şey örnek veri ya da bellekte.

### Zengin taraf: oturum & analitik modeli

`SessionRecord` (`Models.swift:222`) sandığından zengin: tarih, spot, spor, rating, süre, mesafe (NM), max/avg hız, `speedSamples[]`, planing/riding dakikaları, **tack/gybe sayısı**, port/starboard dağılımı, oturum rüzgârı (min/max/avg/gust/yön) **+ o günkü tahmin** (forecast-vs-reality karşılaştırması için). `AnalyticsModels.swift` bunun üstüne spor+hedefe göre uyarlanan özet metrikleri, dönem karşılaştırmaları (hafta/ay/sezon/yıl) ve kanıt-eşikli Insights (en hızlı koşul/spot/gear) kuruyor — hepsi şu an **client'ta** hesaplanıyor.

## 4. Kullanıcının eklediği, PRD/kodda eksik olanlar

Bunlar kullanıcının sözlü çerçevesinde net ama ne v0.2 PRD'de öne çıkıyor ne de kodda var — **backend tasarımını doğrudan etkiler:**

- **Anonim → login kimlik modeli.** Anonim kullanılabilmeli, sonra giriş yapınca veri (oturumlar, profil, favoriler, alarmlar) hesaba bağlanıp buluta kaydedilmeli. Bugün kimlik katmanı sıfır. Backend'in muhtemelen ilk sorusu: kimlik/hesap + anonim cihaz → hesap migrasyonu.
- **Apple Watch veri toplama.** Kullanıcı gerçek bir parça gibi konuşuyor; PRD'de V2 (§10.25), kodda yok. Backend oturum modeli watch'tan gelen veriyi de kabul edecek şekilde düşünülmeli (kaynak: phone | watch).
- **Gerçek GPS analitiği.** Kullanıcının "olaylar basit değil" dediği yer: peak split'ler ve VMG şu an sahte. Gerçek olduğunda ham GPS track'i (nokta dizisi + zaman) bir yerde durmalı ve analiz edilmeli — bu client'ta mı, backend'de mi yapılacak, backend kapsamının kilit sorusu.

## 5. PRD'den önemli sapmalar (dökümanı okurken dikkat)

Bunlar benim ilk taslağımda fazla/yanıltıcıydı; düzeltiyorum:

- **Tek sağlayıcı vs. çok-sağlayıcı IP.** PRD §12 "tek sağlayıcıya güvenme" diyor ve "istasyon seçim skoru + istasyon güven skoru"nu **top-3 monetizasyon** kabul ediyor. Ama **kod bilinçli olarak tersini yapmış**: tek kaynak **Open-Meteo (ICON-EU)** ve `ForecastModels.swift:73` açıkça *"Open-Meteo canlı istasyon ve güven ölçüsü sunmuyor, sayfa bu yüzden hiçbirini iddia etmiyor"* diyor. Yani PRD'nin "istasyon IP" hikâyesi mevcut ürün yönünde **terk edilmiş**. Backend'i buna göre konuşmalıyız: istasyon-güven skoru gerçekten yol haritasında mı, yoksa sade çok-model tahmin mi?
- **Kod v0.3, döküman v0.2.** Kod `v0.3 spec`e atıf yapıyor (5 sekmeli kabuk, Alerts'in sekme olmaktan çıkması, analitik alanı). Diskteki tek yazılı spec v0.2. **Kod, yazılı PRD'den bir sürüm ilerde** — gerçek "kaynak", kod + senin kararların.

## 6. Diğer parçalar (kısaca)

- **weather-sim/** — WebGL2 canlı gökyüzü prototipi (volumetrik bulut, yağış, fırtına, gerçek astronomi, 28 WMO kodu, sunucusuz). `TECHNICAL.md` Metal port spec'i. iOS'taki `WeatherSky` bunun taşınmış hali — **hava kodunu Open-Meteo besleyecek, konumu şu an İstanbul'a sabit.**
- **splash-design/** — PRD v0.2 + HTML mock'lar + tasarım skill'leri. Personalar, monetizasyon sıralaması, 25 ekran brief'i, veri modeli (§13), backend gereksinimleri (§14: `/v1/spots/...`, favoriler, alarmlar, oturumlar, gear; Postgres+PostGIS + TS/Node önerisi), 10 günlük plan.

## 7. Özet: backend'in dolduracağı boşluk

Uygulama, **tek cihazlık, tamamen local bir prototip.** Sunucu-şekilli her yüzey stub: kimlik/hesap, spot & tahmin verisi, alarm değerlendirme + push, abonelik, canlı GPS, ve profil/alarm/favori kalıcılığı. Backend tam olarak bu boşluğu dolduracak.

**Bir sonraki adım (birlikte):** ihtiyaç belirleme. Netleştirmemiz gereken açık sorular:
1. Kimlik: anonim → Apple ile giriş; anonim cihaz verisinin hesaba taşınması gerekli mi?
2. Hava verisi yönü: sade Open-Meteo çok-model mi, yoksa PRD'deki istasyon-güven IP'sine geri mi dönülüyor?
3. GPS analitiği (peak split/VMG) client'ta mı backend'de mi hesaplanacak; ham track saklanacak mı?
4. Alarm değerlendirme + push tetikleme backend cron'unda; APNs entegrasyonu.
5. Abonelik doğrulama server-side mı (StoreKit/RevenueCat webhook) yoksa sadece client-side entitlement mi?
6. Apple Watch veri girişini oturum modeli baştan destekleyecek mi?
