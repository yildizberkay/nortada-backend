# RFC-0000: <Başlık>

<!--
Bu dosya RFC ŞABLONUDUR. Yeni RFC = bu dosyayı kopyala → `docs/rfc/<NNNN>-<kebab-isim>.md`.
Her RFC bu iskeleti kullanır (her bölüm dolmayabilir → "N/A" yaz, bölümü silme).
Numara 4 haneli, sıralı. Status/Step meta tablosunu güncel tut.
-->

|  |  |
|---|---|
| **RFC** | 0000 |
| **Başlık** | <kısa başlık> |
| **Status** | 🟡 Draft |
| **Step** | <implementasyon adımı, ör. 2> |
| **Depends on** | <RFC-XXXX, yoksa —> |
| **Domain(ler)** | <platform/... veya feature/...> |
| **Updated** | YYYY-MM-DD |

> **Status lejantı:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected
> RFC hayat döngüsü: implementasyona başlarken `🚧 In Progress`; bitince `✅ Completed`. İmplementasyon sırasında karar değişirse RFC güncellenir.

## 1. Özet
Tek paragraf: bu RFC neyi çözüyor.

## 2. Motivasyon / bağlam
Neden gerekli; hangi kararlara ([[decisions]]) ve dökümanlara dayanıyor.

## 3. Kapsam (In / Out)
**In:** bu RFC'nin ürettiği. **Out:** bilinçli dışarıda bırakılan / başka RFC'ye ait.

## 4. Veri modeli (Drizzle tabloları)
`pgTable`/`pgEnum` tanımları, `id`+`uid` deseni, jsonb `$type`, ilişkiler, index'ler. Migration notu.

## 5. API yüzeyi (routes + OpenAPI)
Endpoint'ler (`/v1/...`), method, auth gereksinimi, request/response Zod şemaları (`.meta({ref})`), operationId.

## 6. Servisler & mantık
Service metotları, iş kuralları, orkestrasyon; hangi repository'lere/diğer servislere bağımlı.

## 7. Arka plan işleri (Trigger.dev)
Task'ler (`<name>.{schema,task,trigger}.ts`), cron/schedules, tetikleme noktası. Yoksa N/A.

## 8. Bağımlılıklar & entegrasyonlar
Dış servisler (Clerk, RevenueCat, Open-Meteo, APNs...), env değişkenleri, diğer RFC'ler.

## 9. Güvenlik & gizlilik
Auth/yetki, PII, veri sahipliği, rate-limit, hassas veri.

## 10. Test
Hangi service'lere `*.service.spec.ts`, kritik senaryolar (happy + error), mock'lanacak bağımlılıklar.

## 11. İmplementasyon adımları (checklist)
Sıralı, kontrol edilebilir maddeler ("Yeni domain checklist"i ile hizalı).

## 12. Açık sorular
Karara bağlanmamış noktalar.

## 13. Referanslar
İlgili döküman/RFC/dış kaynak linkleri.
