# Nortada — Activity (Session) Veri Modeli

*Kullanıcının tam aktivite spec'inin backend'e uygun, sadeleştirilmiş ve fazlanmış hâli. İki tasarım hamlesi: (1) katmanlı depolama (raw/derived/correction/context) tablo yapısına maplenir; (2) tekrarlayan spor bölümleri **paylaşılan primitiflere** indirilir — spor davranışı `sport_definition`'daki modül listesinden gelir, historik veriyi yeniden yazmaya gerek kalmaz. [[metrics-catalog]] A ailesini bu belge detaylandırır; birim politikası [[decisions]] D-06.*

## 0. Çekirdek kural — depolama katmanları

Kullanıcının koyduğu kural, dört katmana oturuyor:

| Katman | Ne | Mutasyon | Tablo(lar) |
|---|---|---|---|
| **L0 Raw** | kaydın değişmez hâli | write-once, **asla değişmez** | `activity` (değişmez kimlik), `activity_track`, `activity_health`, `activity_condition` |
| **L1 Derived** | hesaplanan analiz | **algoritma sürümüyle yeniden hesaplanabilir** | `activity_summary`, `activity_effort`, `activity_interval`, `activity_maneuver`, `activity_event`, `activity_timeline`, `activity_route`, `activity_analysis` |
| **L2 Correction** | kullanıcının manuel düzeltmesi | ayrı satır, L0/L1'i **değiştirmez** | `activity_correction` |
| **L3 Context** | kullanıcının girdiği bağlam | serbestçe düzenlenir | `activity` üstünde alanlar/JSONB + `activity_equipment` |

Her L1 satırı **analiz metadata'sı** taşır: `analysis_type`, `algorithm_version`, `input_data_version`, `computed_at`, `confidence`, `auto_calculated`, `user_corrected`. Detektörler iyileşince L0'dan L1 yeniden üretilir (Trigger.dev task — D-01 kanonik hesap).

---

## 1. Ortak veri (tüm sporlar)

### L0 — Raw

**`activity`** (değişmez kimlik + statü)
- kimlik: `id`, `uid`, `userId`, `sportId` (→ sport_definition), `customName?`, `status` (active|processing|completed|failed), `source` (iphone|watch|import|manual), `originalImportedType?`, `dataVersion`
- zaman: `startedAt`, `endedAt`, `timezone`, `elapsedSec`, `movingSec`, `pausedSec`, `pausePeriods` (JSONB)
- konum: `spotId?`, `spotName`, `startPoint`, `endPoint`, `country?`, `region?`, `locality?`, `bbox`, `maxDistanceFromStart`, `addressMeta?` (JSONB, ikincil)
- provenans: `device`, `deviceModel`, `osVersion`, `appVersion`, `sensorSources` (JSONB), `importedFileType?`, `externalActivityId?`, `rawFileRef?`, `wasImported`, `importedAt?`
- oluşturma/güncelleme: `createdAt`, `updatedAt`

**`activity_track`** — ham yüksek çözünürlüklü rota. **Samples object storage'da** (S3/R2, gzipli JSON); tablo satırı yalnız `storage_key` + `sample_count` tutar (karar: [[otonom-kararlar]] §30). Örnek başına: `t`, `lat`, `lon`, `altitude`, `groundSpeed`, `course`, `hAccuracy`, `vAccuracy`, `source`, `isPaused`. **Değişmez.** ([[gps-tracking]])

**`activity_health`** — HR/enerji ham örnekleri (blob), HealthKit varsa. *(Apple Watch fazı — schema hazır, veri sonra.)*

**`activity_condition`** — `kind` (forecast|observed) ile **ayrı** satırlar (forecast-vs-reality için şart). Alanlar: provider, model, issueTime/validTime/observedAt, wind/gust/direction, temp/apparent, precip, cloud, visibility, weatherCode; observed'da ayrıca station/gridSource, distanceToSource, confidence; opsiyonel water/wave. Değişmez snapshot. ([[weather-openmeteo-mapping]])

### L1 — Derived (versiyonlu)

**`activity_summary`** — çekirdek özet (tek satır): totalDistance, maxSpeed, avgSpeed, avgMovingSpeed, duration, movingDuration, pauseDuration, start/endPoint, maxDistanceFromLaunch, elevGain/Loss?, validSampleCount, gapCount/gapDuration + analiz metadata.

**`activity_route`** — hızlı render için: `polyline` (encoded), farklı zoom için `simplified` LOD'ları (JSONB). L0 track'ten türetilir.

**`activity_effort`** — best efforts (satır başına bir efor). `type` enum tüm varyantları toplar: zaman (2s,5s,10s,20s,30s,1m,5m), mesafe (100m,250m,500m,1km,nm), **alpha** (250,500,1k), best5x10, bySide, whilePlaning/Foiling. Her satır: result, start/endTime, duration, distance, start/endLoc, `segment` (rota parçası), confidence. **Çok kısa seanslarda geçersiz efor üretme/saklama.** *(Cross-session rekor/insight bu tabloyu okur — o yüzden JSONB değil tablo.)*

**`activity_interval`** — **paylaşılan primitif; tekrarlayan bölümlerin çoğunu tek tabloya indirir.** `kind` enum: planing · foiling · port · starboard · close_hauled · close_reach · beam_reach · broad_reach · running · upwind · downwind · reaching · moving · idle · headwind · tailwind · crosswind. Her satır: start/endTime, duration, distance, avgSpeed, maxSpeed, `extras` (JSONB, kind'e özel), detectionMethod, confidence. → planing/foiling/port-starboard/point-of-sail/movement/conditions-impact analizlerinin **hepsi** bu.

**`activity_maneuver`** — **paylaşılan primitif.** `type` (tack|gybe|transition), timestamp, location, direction (p2s|s2p), entrySpeed, minSpeed, exitSpeed, speedLoss, duration, success (bool), confidence, `userCorrectionId?`. → windsurf/wing/kite/sailing manevralarının hepsi aynı yapı.

**`activity_event`** — genel zaman çizelgesi olayları: start, finish, pause, resume, peak_speed, user_marker, gps_loss, gps_recovery, sensor_loss, sensor_recovery, split, auto_lap.

**`activity_timeline`** — Performance Timeline (paylaşılan zaman ekseni, blob/downsampled). Seriler: speed, pace, heartRate, obsWind, obsGust, fcWind, fcGust, windDir, course, altitude, movementState, pauseState. Hepsi aynı timestamp'i paylaşır (üst üste çizim için).

**`activity_analysis`** — `(activityId, module)` başına versiyonlu JSONB **rollup**'lar (özet düzeyi; ince taneli veri yukarıdaki tablolarda). Modüller: maneuver_summary (count/successRate/avgLoss/best), planing_summary, foiling_summary (takeoffs/touchdowns/longestFlight), side_balance, wind_relative (bestVMG up/down, TWA, polarPoints), legs (sailing), splits (sup/kayak), stroke (sup/kayak), data_quality. Modül açık mı → `sport_definition`.

### L2 — Correction
**`activity_correction`** — hedef + yeni değer (ör. maneuver `type` düzelt, planing eşiği override, spot yeniden adlandır, efor geçersiz kıl). L0/L1'i değiştirmez; okuma sırasında üstüne uygulanır. Alanlar: `target` (entity+id/field), `oldValue?`, `newValue`, `createdAt`.

### L3 — Context (kullanıcı, mutable)
`activity` üstünde ya da `activity_context`: notes, feeling, goal, tags[], perceivedEffort, privateComment, privacy (private|followers|public), hideStart, hiddenRadius, shareId, photos[]. Ayrıca **`activity_layout_override`** — sadece kullanıcı o seans için düzeni özelleştirirse (varsayılan `user_sport_profile`'da, her seansa kopyalanmaz).

### Equipment ilişkisi
**`activity_equipment`** — (activity ↔ equipment_profile) + role + isDefault + **`snapshot` (JSONB)** kayıt anındaki değerler. Çoklu olabilir. *Snapshot şart: profil sonradan düzenlenince eski seans yeniden yazılmaz.*

---

## 2. Sadeleştirme — spor = paylaşılan modüllerin açık/kapalı hâli

Spec'teki "windsurf/wing/kite/sailing/sup/kayak" bölümleri büyük ölçüde **aynı primitifler.** Spor başına farklı olan sadece **hangi modüllerin açık olduğu** + ekipman tipi + birkaç spora-özel bit. Bu tablo `sport_definition`'da yaşar:

| Spor | Efforts | Maneuvers | Intervals | Wind-relative | Spora özel |
|---|---|---|---|---|---|
| Windsurf | standart + alpha + bySide + planing/foiling | tack/gybe | planing **veya** foiling (riding_mode) + port/starboard | opsiyonel (VMG/TWA/polar) | riding_mode (fin/foil) |
| Wingfoil | standart + foiling + bySide | tack/gybe | foiling + port/starboard | opsiyonel | — |
| Kite | standart + foiling(kitefoil) + bySide | transition (twintip) / tack-gybe (dir/foil) | foiling(kitefoil) + side_balance | — | jumps (gelecek) |
| Sailing | standart (kısıtlı) | tack/gybe | point_of_sail + port/starboard | **VMG/polar/legs** (çekirdek) | legs, racing (ops.) |
| SUP | standart | — | moving/idle + conditions_impact | — | splits/pace, stroke |
| Kayak | standart | — | moving/idle + conditions_impact | — | splits/pace, stroke |
| Other | standart (route/speed/dist/dur/conditions/effort/splits) | **kapalı** | moving/idle | **kapalı** | classification + product feedback |

"Other"da otomatik hesaplanMAyanlar: tack/gybe, planing, foiling, port/starboard, alpha, VMG, polar. Sadece generic yapı.

---

## 3. Ayrı tutulan yapılar (aktiviteden bağımsız)

- **`sport_definition`** (ürün-kontrollü): supportedModules, defaultModuleOrder, terminology, compatibleEquipment, advancedMetrics, requiredDataSources, defaultThresholds. → spor davranışını view kodundan çıkarır, tanım değişince historik veri yeniden yazılmaz.
- **`user_sport_profile`** (user+sport başına bir): primaryActivity, enabledSections, sectionOrder, defaultTimelineLayers, defaultEquipment, planing/foilingThresholds, unitPrefs, sportPrefs. Seans buna **referans** verir; sadece override'da kopya tutar.
- **`equipment_profile`** (yeniden kullanılabilir kütüphane): `type` (board|sail|wing|kite|foil|boat|sup|kayak|paddle|generic) + `attributes` (JSONB tip-özel: volume/size/mast/boom/fin/frontWing...). Seans referans + snapshot tutar.

---

## 4. Fazlama

| Faz | Kapsam |
|---|---|
| **P0 — MVP** | L0 `activity`+`activity_track`+`activity_condition`(fc+obs snapshot); L1 `activity_summary`, `activity_route`(polyline), `activity_effort`(standart zaman+mesafe); `activity_equipment`(+snapshot); L3 context+privacy+provenance; temel `data_quality`. Sporlar: **windsurf, wingfoil, sailing, other.** Manevra **sayısı** (tack/gybe) + basit planing/foiling %'si hafif dâhil edilebilir. |
| **P1** | `activity_maneuver` (detay) + `activity_interval` (planing/foiling/port-starboard) + **alpha** efforts + `activity_timeline` (+ chart) + forecast-vs-reality + **`activity_correction`** mekanizması. |
| **P2** | `wind_relative` (VMG/TWA/polar); sailing point_of_sail + legs; SUP/kayak splits+stroke; kite transitions; **HealthKit/HR (Apple Watch fazıyla)**. |
| **P3** | sailing racing; kite jumps; foiling consistency; polar comparison; gelişmiş analizler. |

**Not — Apple Watch:** `source`/`activity_health` schema'sı P0'dan itibaren hazır (kullanıcı isteği: "veri kaynağı alanını baştan uygun yap"), ama HR/enerji verisi P2'de (watch) doldurulur. Kayıt-öncesi hiçbir spora-özel motoru bloklamaz.

**Not — geçersiz efor:** çok kısa seanslarda time/distance efforları hesaplanmaz (özellikle 1Hz precision'da 100m sınırda — [[gps-tracking]]).
