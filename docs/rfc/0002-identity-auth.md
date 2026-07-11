# RFC-0002: Kimlik & Auth

|  |  |
|---|---|
| **RFC** | 0002 |
| **Başlık** | Kimlik & Auth (anonim JWT + Clerk, merge) |
| **Status** | 🟡 Draft |
| **Step** | 1 |
| **Depends on** | RFC-0001 |
| **Domain(ler)** | platform/auth |
| **Updated** | 2026-07-11 |

## 1. Özet
Unified kimlik: her istek bir JWT taşır. **Anonim** kullanıcı `auth` domaininin ürettiği ince, cihaza bağlı JWT'yle gelir (arkasında `is_anonymous` user satırı); **giriş yapmış** kullanıcı **Clerk** (native iOS/watchOS Sign in with Apple + e-posta) ile. Login olunca anonim satır Clerk hesabına **link/merge** edilir. ([[decisions]] D-002)

## 2. Motivasyon / bağlam
Kullanıcı "anonim adamın da JWT'si olsun, unified olsun" dedi; ama anonimi Clerk user'ı yapmak MAU faturası + Clerk'te native anonim yok. Çözüm: Clerk gerçek girişleri (en büyük yük: Apple sunucu doğrulaması, güvenlik) alır; anonimi ucuza kendimiz yönetiriz. Desen brandscale `authenticate-app-jwt`.

## 3. Kapsam (In / Out)
**In:** anonim JWT üretme/doğrulama, Clerk token doğrulama, dual-auth middleware (`c.var.user`), anonim→hesap link/merge, `POST /v1/auth/anonymous`, `POST /v1/auth/link`, `GET /v1/auth/me`.
**Out:** profil alanları (RFC-0003), favoriler (0003), abonelik tier (0009).

## 4. Veri modeli (Drizzle)
**`user`** — `id`, `uid`, `clerkUserId text unique?` (anonimde null), `isAnonymous bool`, `anonymousDeviceId text?` (Keychain'deki cihaz kimliği), `email?`, `displayName?`, `mergedIntoUserId?` (bu anonim satır başka hesaba merge edildiyse — soft), `createdAt`, `updatedAt`.
- Index: `clerkUserId` unique (partial, not null), `anonymousDeviceId`.
- Merge sonrası anonim satır silinmez; `mergedIntoUserId` ile işaretlenir (audit + eski token'ın nazikçe reddi).

## 5. API yüzeyi
- `POST /v1/auth/anonymous` — cihaz `anonymousDeviceId` (+ attestation opsiyonel) gönderir → anonim `user` satırı bul/oluştur, **anonim JWT** dön (uzun ömürlü, cihaz Keychain'de tutar). Auth: yok (bootstrap).
- `POST /v1/auth/link` — anonim JWT + geçerli **Clerk token** → anonim satırdaki veriyi Clerk hesabına taşı (bkz §6 merge), Clerk-tabanlı `user` dön. Auth: anonim JWT.
- `GET /v1/auth/me` — mevcut user. Auth: her ikisi.

## 6. Servisler & mantık
- `AuthService.issueAnonymous(deviceId)` — bul/oluştur + JWT imzala (kendi secret'ımız, `AUTH_JWT_SECRET`; `sub=user.uid`, `typ=anon`).
- `AuthService.verify(token)` — `typ=anon` ise kendi JWT'mizi doğrula; değilse Clerk `@clerk/backend` ile doğrula → `clerkUserId`'den user bul (yoksa provision).
- **`AuthService.linkAnonymousToClerk(anonUser, clerkIdentity)`** — merge akışı:
  1. Clerk `clerkUserId` için user var mı? **Yoksa** → anonim satırı yükselt (`clerkUserId` set et, `isAnonymous=false`, email/name doldur). En basit, veri zaten yerinde.
  2. **Varsa** (kullanıcı başka cihazda zaten hesap açmış) → anonim satırın sahip olduğu kayıtları (activities, favorites, alerts) hedef Clerk user'a **reassign** et (transaction, repo'da); anonim satırı `mergedIntoUserId=clerk.id` işaretle. Çakışma: aynı kaydın iki tarafta olması nadir (anonim cihaz-yerel) → basit "hedefte yoksa taşı".
  3. Reassign kapsamı domain'ler eklendikçe genişler (activity/favorites/alerts) — her domain repo'su `reassignOwner(fromUserId, toUserId, tx)` sağlar.
- Middleware `authenticate` → `AuthService.verify` → `c.var.user: User`. Opsiyonel-user route'lar `HonoContext<true>`.

## 7. Arka plan işleri
Yok (senkron). İleride: anonim satır GC (uzun süre link olmayan + inaktif) — sonra.

## 8. Bağımlılıklar & entegrasyonlar
`@clerk/backend` (JWKS doğrulama), kendi JWT için `jose`/`hono/jwt`. Env: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `AUTH_JWT_SECRET`, `AUTH_ANON_TOKEN_TTL`. iOS: Clerk iOS SDK `signInWithApple()`.

## 9. Güvenlik & gizlilik
Anonim JWT uzun ömürlü ama düşük yetkili (yazma user-scoped, kendi verisi). Clerk token kısa ömürlü + refresh (SDK). Merge transaction'lı, idempotent. Attestation (App Attest) opsiyonel — anonim endpoint abuse'a karşı rate-limit. Merge sonrası eski anonim token reddedilir (`mergedIntoUserId` kontrolü).

## 10. Test
`auth.service.spec.ts`: issueAnonymous (yeni/mevcut cihaz), verify (anon/clerk/invalid), **linkAnonymousToClerk her iki dal** (Clerk user yok → upgrade; var → reassign), merge idempotency, reassign çağrıları mock.

## 11. İmplementasyon adımları
1. `user` tablosu (schema + dbSchema + type).
2. `auth/errors.ts`, `schemas/` (anonymous/link/me), `repositories/user.repository.ts` (findByClerkId/findByDeviceId/create/upgrade/reassign hook).
3. `auth/services/auth.service.ts` (+spec), JWT util, Clerk verify.
4. `middlewares/authenticate.middleware.ts` (dual) → `c.var.user`.
5. `auth.module.ts`, `container` + `registerRoutes` (`/v1/auth`).
6. lint/type/test.

## 12. Açık sorular
- App Attest / attestation P0'da mı, sonra mı? (öneri: sonra; başta rate-limit yeter.)
- Clerk e-posta stratejisi (magic link / OTP) — Clerk dashboard config; kod tarafını etkilemez.

## 13. Referanslar
[[decisions]] D-002 · [[reference/brandscale-architecture]] §11 (authenticate-app-jwt)
