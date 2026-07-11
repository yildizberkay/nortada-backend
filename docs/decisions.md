# Splash Backend — Karar Log'u (ADR)

*Backend'i kurarken alınan kararların çalışan kaydı. En güncel üstte. Tartışma bağlamı: [[SPLASH-OVERVIEW]], [[metrics-catalog]], [[reference/brandscale-architecture]].*

---

## D-007 — Launch beachhead: Türkiye Ege (global mimari, bölgesel küratörlük)
**Karar:** Mimari **gün 1'den global** (OSM global, spot şeması global, her bölgeden spot toplanabilir). Ama **küratörlü launch kalitesi Türkiye Ege kıyısından başlar** (Çeşme/Alaçatı + Gökova/Akyaka kite + Urla + Bodrum/Datça) + İstanbul/Marmara; sonra bölge bölge genişler: Ege → Yunanistan → Tarifa/İspanya → Mısır/Kızıldeniz → global.
**Neden (analitik):** (1) Ekip İstanbul'da → en sıkı feedback döngüsü. (2) Alaçatı dünyanın en iyi 7 windsurf merkezinden biri, her Ağustos **PWA Dünya Kupası** orada, ASPC dünya top-5/Avrupa top-3 → marquee spot Avrupalı gezgin sürücüleri de çeker, yani Türkiye-first beachhead bile "global" hedefe dokunur. (3) Yoğunluk > nicelik: ilk kullanıcılar thin global kapsama yerine iyi küratörlü mükemmel deneyim alır. (4) Genişleme yolu net: en yoğun Avrupa/Akdeniz pazarları (Avrupa kite/windsurf pazarının ~%35-42'si) sırayla eklenir. Kullanıcı "global olacak" dedi → mimari global; "kalite>nicelik/beachhead" → küratörlük Ege'den. İkisi böyle uzlaşır.

## D-006 — Birim dönüşümü client tarafında
**Karar:** API kanonik değerleri **tek temel birimde** döner (SI: hız m/s, mesafe m, sıcaklık °C); knot/km/mph/NM/°F dönüşümü + formatlama **client'ta** yapılır. Yazma tarafında (alarm eşiği gibi kullanıcı girdileri) client, temel birime çevirip gönderir.
**Neden:** En güçlü sebep **cache**. Hava verisi kullanıcılar arasında paylaşılır; sunucu birime çevirseydi aynı tahmini knot-kullanıcısı ve km/h-kullanıcısı için ayrı ayrı cache'lemek gerekirdi. Tek kanonik değer = tek cache girdisi herkese hizmet eder. Ayrıca birim değiştirme anlık/offline olur (round-trip yok), sunucu basitleşir. Bedeli: her client (telefon/watch/web) dönüşümü tutarlı yapmalı — ama dönüşüm trivial, ufak paylaşılan bir modül yeter.

## D-005 — Insight'lar için şema, dönem sorgusuna göre
**Karar:** Her seansın metrikleri seans yazılırken hesaplanıp **satırda saklanır** (ham track'ten yeniden hesaplamaya gerek kalmadan); insight/dönem sorguları `(userId, date)` index'i üzerinden ucuz agregasyon yapar. Window'lar hafta/ay/sezon/yıl (app `ActivityPeriod`).
**Neden:** Insight'lar birikime + zaman penceresine dayanıyor; per-seans metrik önceden hesaplı olunca dönem karşılaştırmaları (bu hafta vs geçen hafta) sadece satır toplama olur.

## D-004 — Hava: talep/ilgi-güdümlü cache, global tazeleme YOK
**Karar:** Hava verisi **spot bazında cache'lenir** (TTL'li: gözlem ~10 dk, tahmin ~1-3 saat, PRD §14.4). Trigger.dev cron sadece **"sıcak set"i** tazeler = aktif alarmı olan + favorilenen + son zamanlarda görüntülenen spotlar. Kullanıcı bir spotu açınca cache miss ise anında çekilir + ısıtılır. **Bütün dünyayı durup dururken tazelemek yok.**
**Neden:** Kullanıcının noktası. Maliyeti (Open-Meteo çağrısı + iş) ilgiyle sınırlar; alarmlı bölge zaten sık tazelenmeli, gerisi lazım oldukça. Rüzgâr vektör *ızgarası* (haritada çizim için) da aynı cache'ten veri olarak gelir; **çizim işi client'ta** (app'te `WindField`/`WeatherSky` var), backend sadece ızgara verisini (lat/lon noktalarında hız+yön) sağlar.

## D-003 — 30k spot için PostGIS gerekmez, sade Postgres yeterli
**Karar:** ~30.000 spot ölçeğinde nearby/search için **sade Postgres** — `(lat, lon)` üzerinde bounding-box ön-filtre + haversine (istenirse `cube`/`earthdistance` + GiST index). PostGIS'e şimdilik gerek yok; milyonlarca satır ya da poligon/karmaşık uzamsal işlem gelince değerlendirilir. **3rd-party geo API kullanılmayacak** (nearby = kendi DB'miz; harita karoları MapKit'ten bedava). Geocoding/adres-arama gerekirse ileride ayrı konu.
**Neden:** 30k satırda haversine taraması bile ms-altı; PostGIS'in kurulum/bakım maliyeti bu ölçekte karşılıksız.
**Açık iş (ayrı faz):** Spot'ları **nereden** bulacağız? Asıl problem burası — spot veri tabanımız yok. Kaynak seçenekleri: açık veri setleri (OSM sınırlı), manuel küratörlük, uygulamadaki "Suggest Spot" akışı, bilinen spot listeleri. İlgili faza geçince ayrıca çözülecek.

## D-002 — Auth: Clerk (Apple + e-posta) + kendi ince anonim JWT'miz
**Karar:** Gerçek girişler için **Clerk** (native iOS + watchOS Sign in with Apple + e-posta). Anonim kullanıcıları **Clerk user'ı YAPMAYIZ** (Clerk MAU başına ücretlendirir; milyonlarca anonim pahalı olur + Clerk'te native anonim yok). Bunun yerine `auth` domainimiz **ince bir anonim JWT** üretir (cihaza bağlı, Keychain'de saklı), arkasında `is_anonymous` sunucu user satırı. Middleware Clerk token'ını da anonim token'ı da kabul eder → `c.var.user` (brandscale'deki `authenticate-app-jwt` deseni). Apple/e-posta ile giriş olunca anonim satırın verisi Clerk hesabına **link/merge** edilir.
**Neden (yük değerlendirmesi):** "Hem Clerk hem anonim" DÜŞÜK ek yük — (a) anonim için bir JWT üret+doğrula, (b) iki token tipini kabul eden bir middleware, (c) login'de anonim veriyi hesaba bağlayan bir endpoint. Buna karşılık auth'u tümüyle içeri almak = Apple sunucu doğrulaması + e-posta/OTP + session/refresh rotasyonu + süregelen güvenlik yükü; küçük ekip için büyük ve bitmeyen iş. Clerk en büyük yükleri (native Apple/watchOS + güvenlik) alıyor; anonim boşluğu ucuza dolduruyoruz ve anonimler Clerk MAU'su olmadığı için maliyet düşük kalıyor.

## D-001 — Kanonik metrik hesabı backend'de
**Karar:** Kanonik/resmî metrikler **backend'de** (Trigger.dev task, ham track'ten) hesaplanır ve saklanır; cihaz sadece seans sırasında hafif/anlık metrikleri gösterir (UX). **Resmîlik iddiası yok** — hızı/metrikleri hesaplarız ama "resmî hız rekoru" (GPS-Speedsurfing onaylı doppler cihaz gerektiren) iddiası taşımayız; topluluk olabilir, resmîlik ayrı olay. Ham track + hesaplanmış metrik ikisi de saklanır.
**Neden:** Tek motor = phone/watch/web tutarlılığı; algoritma iyileşince saklı ham track'ler üzerinde app yayınlamadan yeniden hesap; cihaz kısıtlarından bağımsız otoriter değer.
