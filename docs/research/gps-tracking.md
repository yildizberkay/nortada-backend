# GPS tracking — iOS'ten ne alıyoruz, kaç MB, nasıl gönderiyoruz?

*Araştırma notu (2026-07-11). Soru: bir seansta iOS'ten hangi GPS verisi çıkar, boyutu ne olur, backend'e nasıl taşınır? Aşağıdaki sayılar ölçüm + hesap; tasarım önerisi sonda.*

## 1. iOS'ten çıkan veri (Core Location)

Canlı tracking'de `CLLocationManager` bir dizi `CLLocation` örneği üretir. Speedsurfing için anlamlı alanlar:

| Alan | Tip | Not |
|---|---|---|
| `timestamp` | Date | örnek zamanı |
| `coordinate.latitude/longitude` | Double | ~6-7 ondalık anlamlı |
| `speed` | Double (m/s) | **Doppler hızı** — GPS chip'inden; speedsurfing'in temeli |
| `speedAccuracy` | Double | hız güveni (spike filtreleme için) |
| `course` | Double (°) | gidiş yönü (heading) |
| `courseAccuracy` | Double | |
| `horizontalAccuracy` | Double | konum güveni (kötü örnekleri atmak için) |
| `altitude` / `verticalAccuracy` | Double | su sporunda düşük değer; opsiyonel |

**Örnekleme hızı: pratikte ~1 Hz.** iPhone GPS'i `kCLLocationAccuracyBestForNavigation` ile de facto saniyede 1 örnek verir; donanım GT-31/GW-60 gibi 5–10 Hz doppler logger'lara çıkamaz. Bunun sonucu (araştırmadan): iPhone app'leri "eğlence/sıralama" için yeterli — dedicated cihazlarla **5×10sn** rakamları ~0.1 knot içinde örtüşüyor — ama resmî rekor için onaylı değil. Yani Nortada'nın tracking'i ciddi bir hobici deneyimi verebilir; "GPS-Speedsurfing.com'a rekor gönder" seviyesi ayrı bir konu (GPX export ile köprülenebilir).

Konfigürasyon (backend'i etkileyen kısım): `desiredAccuracy = BestForNavigation`, `distanceFilter = none` (her örneği al), `activityType = .fitness`, `allowsBackgroundLocationUpdates = true` + Info.plist `UIBackgroundModes: location` + "Always/When in use" izni. Kayıt, ekran kilitliyken / app arka plandayken sürer (uygulamadaki "minimize edilebilir non-modal tracking" bunu zaten öngörüyor). **Batarya:** BestForNavigation + arka plan konum, 2–3 saatlik seansta belirgin batarya yer — beklenen davranış.

## 2. Veri boyutu (hesap)

1 Hz varsayımıyla örnek sayısı: 60 dk = 3.600, **120 dk = 7.200**, 180 dk = 10.800 örnek.

| Kodlama | Bayt/örnek | 120 dk seans | + gzip |
|---|---:|---:|---:|
| Ayrıntılı JSON (8 alan, tam hassasiyet) | ~160 | ~1.15 MB | ~150–250 KB |
| GPX (XML) | ~200–300 | ~1.5–2 MB | ~200–300 KB |
| **Kompakt** (kolonlar, delta-encoded int, yuvarlanmış) | ~30 | ~216 KB | **~40–80 KB** |

**Başlık:** Tipik 1–2 saatlik bir seans **~0.2–1.2 MB ham, gzip'le ~50–250 KB.** 3 saatlik uzun seans bile ~2 MB ham / ~400 KB gzip altında kalır. GPS track'leri çok iyi sıkışır (komşu noktalar arası küçük delta'lar). Depolama da ucuz: 10.000 seans × ~200 KB ≈ ~2 GB.

**Sonuç: boyut bir sorun değil.** Tek bir HTTP isteğiyle rahat taşınır; streaming/chunk gerekmez.

## 3. Nasıl gönderilir? (tasarım önerisi)

**Kritik kısıt: suda internet yok.** O yüzden veri akışı "canlı stream" değil, **cihazda topla → seans bitince yükle** olmalı.

### Önerilen akış

1. **Cihazda kayıt:** örnekler yerelde biriktirilir (dosya/SwiftData buffer). Seans `id`'si cihazda UUID olarak üretilir (uygulamada zaten `TrackingSession.id` var) → yeniden denemelerde idempotent.
2. **Cihazda anlık özet:** hız/mesafe/peak'ler UX için cihazda hesaplanır (kullanıcı anında görsün).
3. **Seans bitince yükle:** `Content-Encoding: gzip` ile tek `POST /v1/sessions` — gövdede seans metadata + kompakt ham örnekler. Boyut <2 MB olduğu için MVP'de bu fazlasıyla yeterli, iki-fazlı presigned-blob'a gerek yok.
4. **Backend kanonik metrikleri hesaplar:** ham track'ten mesafe, filtrelenmiş max hız, 5×10, peak split'ler (2s/10s/100/250/500m/1NM/Alpha 500), ileride VMG — bir **Trigger.dev task**'inde. Cihaz "hızlı ama yaklaşık", backend "tek doğru kaynak". Böylece Apple Watch geldiğinde de aynı motor kullanılır.
5. **Offline kuyruk:** yükleme başarısızsa (bitişte hâlâ sinyal yoksa) yerelde kalır, sinyal gelince / login olunca senkronlanır. Anonim seanslar zaten cihazda; hesaba bağlanınca push edilir → §kimlik akışıyla örtüşür.

### Depolama modeli

- **Ham track** → blob (Postgres `bytea`/jsonb ya da object storage; brandscale R2/S3 presigned deseni ileride büyürse hazır). MVP'de Postgres'te sıkıştırılmış blob kolonu yeterli.
- **Hesaplanmış metrikler + özet** → Postgres satırları (mevcut `SessionRecord` alanlarının backend karşılığı). Sorgu/analitik bunların üstünden döner, ham track'e her seferinde dokunmaz.
- **`source` alanı** her seansta tutulmalı (`phone` | `watch`) — Apple Watch sonra gelecek ama şema baştan hazır olsun (kullanıcının isteği).

### Format kararı

- **İç transport:** kompakt kolonlu/delta JSON (ya da protobuf). Basit başla: gzip'li kompakt JSON.
- **GPX:** sadece **export** için değer (kullanıcı gps-speedsurfing.com'a yükleyebilsin). İç transport için değil.

## 4. Kullanıcının karar vermesi gerekenler

1. **Ham track saklanacak mı, yoksa sadece hesaplanmış metrikler mi?** (Öneri: ham + metrik ikisi de — ham olmadan peak split'ler yeniden hesaplanamaz ve "forecast-vs-reality"/harita hero'su ham track ister. Maliyeti düşük.)
2. **Analitik nerede kanonik?** (Öneri: backend kanonik, cihaz anlık. Tek motor = watch/phone tutarlılığı.)
3. **Resmî speed rekoru iddiası var mı?** (iPhone 1 Hz buna uygun değil; "kişisel/eğlence" konumlandırması + opsiyonel GPX export en dürüstü.)
