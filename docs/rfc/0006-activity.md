# RFC-0006: Aktivite / Seans

|  |  |
|---|---|
| **RFC** | 0006 |
| **Başlık** | Aktivite/Seans (4 katman, GPS upload, kanonik metrik) |
| **Status** | 🚧 In Progress |
| **Step** | 5 |
| **Depends on** | RFC-0002 (user), RFC-0004 (spot), RFC-0005 (conditions) |
| **Domain(ler)** | feature/session |
| **Updated** | 2026-07-11 |

## 1. Özet
Seans kaydı: ham GPS track upload + değişmez saklama, kanonik metrik hesabı (Trigger task), effort/interval/maneuver, ekipman snapshot. 4 katmanlı depolama (raw/derived/correction/context) ve paylaşılan primitifler: tam tasarım [[activity-data-model]]. GPS upload/boyut: [[research/gps-tracking]].

## 2. Motivasyon / bağlam
App tracking'i şu an tamamen simüle (gerçek GPS yok, peak split'ler sahte). Backend kanonik hesap motoru (D-001). Apple Watch sonra ama `source`/`activity_health` şeması baştan hazır.

## 3. Kapsam (In / Out)
**In (P0):** `activity` (L0 kimlik) + `activity_track` (ham) + `activity_condition` (forecast+observed snapshot) + `activity_summary` + `activity_route` (polyline) + `activity_effort` (standart zaman/mesafe) + `activity_equipment` (+snapshot) + context/privacy; upload endpoint (gzip, idempotent); kanonik metrik task. Sporlar: windsurf, wingfoil, sailing, other.
**Out (P1+):** `activity_maneuver`/`activity_interval` detay, alpha, `activity_timeline`, `activity_correction`, wind-relative/VMG, HealthKit (Apple Watch fazı). Bkz [[activity-data-model]] §4 fazlar.

## 4. Veri modeli (Drizzle)
[[activity-data-model]]'deki tablolar. P0 alt kümesi: `activity`, `activity_track` (blob/bytea ya da object storage), `activity_condition` (`kind` forecast|observed), `activity_summary`, `activity_route`, `activity_effort`, `activity_equipment`, `equipment_profile`. Her L1 satırı analiz metadata (`algorithm_version`, `input_data_version`, `computed_at`, `confidence`). `source` (iphone|watch|import|manual) baştan.

## 5. API yüzeyi
- `POST /v1/activities` — `Content-Encoding: gzip`, gövde: metadata + kompakt ham örnekler + cihaz-özet; cihaz `uid` üretir (idempotent). → `activity` (status=processing) + track sakla, kanonik hesap task tetikle.
- `GET /v1/activities?period=&sport=` — liste (özet).
- `GET /v1/activities/:uid` — detay (summary + route + efforts + conditions).
- `PATCH /v1/activities/:uid` — context (notes/rating/tags/privacy).
- `DELETE /v1/activities/:uid`.
- `GET/POST /v1/equipment` — ekipman kütüphanesi.
- Auth: user (anonim JWT de — seansı olur, merge'de taşınır).

## 6. Servisler & mantık
- `ActivityService` — create (track sakla + task tetikle), list (dönem/spor filtre), detail, patch context, delete.
- `ActivityMetricsService` — ham track'ten kanonik hesap: distance, filtrelenmiş max/avg, moving time, best10s/5×10, standart efforlar; (P1) interval/maneuver/alpha. Precision: 1Hz'de 100m "yaklaşık" etiketi; çok kısa seansta efor üretme ([[research/gps-tracking]]).
- `EquipmentService` — profil CRUD; seansa snapshot.
- Reassign hook (RFC-0002 merge): `reassignOwner(from,to,tx)` — aktiviteler + ekipman.

## 7. Arka plan işleri (Trigger.dev)
- `activity-compute-metrics` — `schemaTask`: ham track'i parse et → kanonik metrik/effort yaz → `activity_route` polyline → status=ready. Algoritma sürümü artınca eski seanslarda yeniden çalıştırılabilir (recompute).

## 8. Bağımlılıklar & entegrasyonlar
Conditions snapshot için Weather (RFC-0005) — kayıt anındaki forecast + (ileride observed). Spot (RFC-0004). Ham track büyürse object storage (R2/S3 presigned, brandscale deseni); P0'da Postgres blob yeterli (<2MB, [[research/gps-tracking]]).

## 9. Güvenlik & gizlilik
Ham konum track'i hassas — user-scoped, `privacy` (private/followers/public), `hideStart`/`hiddenRadius`. Rest'te şifreleme. Kullanıcı verisinin sahibi.

## 10. Test
`activity.service.spec.ts` (create idempotent, list filtre, patch, reassign), `activity-metrics.service.spec.ts` (distance/max/avg/best5×10 sabit track'ten, kısa-seans efor üretmeme, spike filtre).

## 11. İmplementasyon adımları
1. P0 tabloları (activity/track/condition/summary/route/effort/equipment/activity_equipment). 2. errors/schemas. 3. repositories (+reassign). 4. `ActivityService` + `ActivityMetricsService` + `EquipmentService` (+spec). 5. `activity-compute-metrics` task. 6. routes + module + register. 7. lint/type/test.

## 12. Açık sorular
- Ham track: Postgres blob mu object storage mu (P0 Postgres, büyürse storage)?
- Kanonik metrik seti P0 kesin listesi — [[metrics-catalog]] A ✅ set ile hizala (kullanıcı uygulamadan kesinleştirecek).

## 13. Referanslar
[[activity-data-model]] · [[research/gps-tracking]] · [[metrics-catalog]] A · [[decisions]] D-001
