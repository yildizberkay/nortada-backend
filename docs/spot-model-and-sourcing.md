# Spot — Şema + Sourcing (spotları nereden bulacağız?)

*Asıl problem: spot veri tabanımız yok, ~30k spotu bir kez bulmamız gerek. Geo *tekniği* çözüldü ([[decisions]] D-03: sade Postgres, PostGIS yok, 3rd-party geo API yok). Bu belge iki şey: (1) spot entity şeması, (2) spotları nereden ve nasıl toplayacağımız.*

## 1. Spot entity şeması

PRD §13.2 + app `Spot` modelinden konsolide:

| Alan | Not |
|---|---|
| `id`, `uid` | internal + public |
| `name`, `country`, `region`, `locality` | |
| `latitude`, `longitude` | `(lat,lon)` index; nearby = bbox + haversine |
| `waterType` | sea \| lake \| bay \| river \| marina \| open_coast |
| `supportedSports[]` | windsurf/wing/kite/sailing/sup/kayak |
| `skillSuitability` | beginner/intermediate/advanced ipucu |
| **`shoreBearingDeg`** | **kıyı yönü — çekirdek IP.** Rüzgâr yönünü side/on/off-shore'a çevirir. Aktivite + hava kararı bunu okur |
| `goodWindDirections[]`, `riskyWindDirections[]` | 16-pt pusula |
| `hazards[]` | offshore risk, sığlık, kaya... (serbest/etiketli) |
| `source` | osm \| curated \| user_suggested |
| `osmId?` | OSM'den geldiyse (dedupe + güncelleme) |
| `status` | published \| pending \| rejected (Suggest Spot moderasyonu) |
| `createdBy?`, `createdAt`, `updatedAt` | |

Not: "istasyon eşlemesi" (station refs) PRD'de vardı ama D-04'te Open-Meteo tek kaynak + istasyon-güven iddiası yok → şimdilik spot'ta istasyon alanı gerekmiyor.

## 2. Sourcing — spotları nereden bulacağız?

### Gerçek durum
Temiz, lisans-uyumlu **açık** veri seti pratikte tek: **OpenStreetMap** (ODbL). Ticari rehberler (Kite&Windsurfing Guide ~3500 spot, Global Kite Spots, TheKiteSpot, Windguru/Windy/Windfinder) kapsamlı ama **ToS-korumalı, kazınamaz** — sadece küratörlükte *referans/doğrulama* için bakılır, kopyalanmaz.

### Strateji: 3 katman

**(a) Toplu aday tohumu — OSM / Overpass API.** Lisans-dostu, global, ücretsiz. İlgili etiketler (aramayla doğrulandı):
- `sport=kitesurfing`, `sport=windsurfing`, `sport=sailing`, `sport=surfing`
- `sport=nautical_center` / `leisure=nautical_center` (kulüp/okul — yelken/windsurf/kite/katamaran)
- `leisure=marina`, `leisure=slipway`, `seamark:type=harbour`
- kıyıya yakın `natural=beach` (aday plajlar)

Bölge-sınırlı Overpass sorgusu (ör. Türkiye):
```overpassql
[out:json][timeout:90];
area["ISO3166-1"="TR"]->.a;
(
  nwr(area.a)["sport"~"windsurfing|kitesurfing|sailing|surfing"];
  nwr(area.a)["sport"="nautical_center"];
  nwr(area.a)["leisure"~"marina|slipway|nautical_center"];
  nwr(area.a)["seamark:type"="harbour"];
);
out center tags;
```
→ aday nokta + ad + (varsa) spor etiketi. **ODbL atıf** zorunlu ("© OpenStreetMap contributors").

**(b) Zenginleştirme — asıl IP burada.** OSM konum + ad verir; ama "spot zekâsı"nı (shoreBearing, iyi/riskli yönler, waterType, desteklenen sporlar, seviye) **biz ekleriz** — farkımız bu.
- **`shoreBearingDeg` yarı-otomatik türetilebilir:** spota en yakın OSM `natural=coastline` çizgisinin yerel teğet açısından hesapla → kıyı yönü. Ölçeklenir, elle girmeye gerek kalmaz. Sonra rüzgâr yönü → onshore/offshore/side geometriyle *sorgu anında* çıkar.
- `goodWindDirections` shoreBearing'den başlatılıp elle rafine edilir; `waterType` bağlamdan (deniz/göl/koy).
- Küratörlük admin işi (PRD §14.3): temizle, dedupe (osmId), yönleri doğrula.

**(c) Büyüme — kullanıcı üretimi.** App'te zaten **"Suggest Spot"** akışı var → yeni spot `status=pending` gelir, admin onaylar. Uzun kuyruğu bu besler.

### Ölçek: 30k değil, önce bölge — kalite > nicelik
30k *global* temiz spot bir hedef, launch şartı değil. **Launch bölgesiyle başla** (sample data + PRD Marmara/Ege → muhtemelen **Türkiye kıyısı**): birkaç yüz iyi küratörlü spot, sonra bölge bölge genişle. OSM toplu tohum kapsamı verir; zenginleştirme + Suggest Spot zamanla 30k'ya taşır. Bir bölgeyi "yayına hazır" yapmak = OSM çek → shoreBearing türet → yönleri/waterType doğrula → publish.

### Faz
- **P0:** launch bölgesi için OSM toplu çek + shoreBearing türetme + elle küratörlük (birkaç yüz spot); Suggest Spot pipeline (pending→publish).
- **P1+:** bölge genişletme, dedupe/güncelleme job'u (Trigger cron ile OSM diff), hazard zenginleştirme.

## Açık karar
- **Launch bölgesi neresi?** (öneri: Türkiye kıyısı — sample data & PRD ile tutarlı). Global mi bölgesel mi başlayacağımız sourcing ölçeğini belirler.
