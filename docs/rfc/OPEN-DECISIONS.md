# Open Decisions & TODOs

Tracks decisions Berkay owns and deferred work across the RFCs. **Autonomous decisions are
OFF (2026-07-11)** — items here are surfaced for Berkay; nothing gets implemented without his
go-ahead. (History of earlier autonomously-made choices lives in `otonom-kararlar.md`.)

Legend: ✅ decided · 🔨 decided, implementation pending · 🕒 deferred (revisit later)

## Decided

- ✅ **[e] Auth token model → short-lived access + refresh + rotation** (RFC-0002).
  **IMPLEMENTED** (2026-07-12, [[decisions]] D-009). Access token **15 min**, refresh token
  **60 days**, rotation-on-use with **family-based reuse detection** (a replayed/rotated token
  revokes the whole family), tokens stored **SHA-256 hashed**. New `POST /v1/auth/refresh`
  (refresh token is the credential; no bearer auth; its own rate-limit bucket). Applies to our
  anonymous-device auth only; Clerk manages its own. **Client contract changed:** `/anonymous`
  now returns `{ accessToken, refreshToken, expiresIn, user }` (was `{ token, user }`). A daily
  cron GCs expired refresh tokens. Follow-up to confirm with product: the 15 min / 60 day TTLs.
- ✅ **[c] Deploy target = Railway** (RFC-0001). Recorded in RFC-0001 §16.
- 🔨 **[f] Object storage = S3-compatible, target Cloudflare R2** (RFC-0006). Adapter is
  already S3-compatible (endpoint + `forcePathStyle` → R2-ready); **no code change**. Pending:
  provision an R2 bucket + credentials, set `OBJECT_STORAGE_*` env (`REGION=auto`,
  `ENDPOINT=<r2>`, `FORCE_PATH_STYLE=true`), then run the one-time upload→compute smoke test.
- ✅ **[b] Canonical metric set** (RFC-0006 / 0007). Current effort + summary set looks right;
  extend later if desired. No action now.

## Deferred (revisit later — not now)

- 🕒 **[a] Wind thresholds & skill bands** (RFC-0005) — **LAST.** Confirm/tune the per-sport
  wind bands and decide whether verdicts vary by `experience_level`. Current: research-backed
  defaults, one band set per sport.
- 🕒 **[d] Clerk email / displayName hydration** (RFC-0002/0003). Currently not fetched from
  the Clerk User API. Decide later whether to hydrate `user.email`/`displayName`.
- 🕒 **[g] Free vs premium + entitlements** (RFC-0008/0009) — **LAST (monetization last).**
  Blocks alert limits + entitlement gating design.
- 🕒 **[h] RevenueCat specifics** (RFC-0009). Sandbox-entitlement policy; webhook signature
  verification. Revisit with (g).
- 🕒 **RFC P1 / fast-follows** (already listed in each RFC's §16 — not urgent):
  - **0005:** thundering-herd single-flight; cadence-aware refresh; live-observation source;
    `wind-field` endpoint; marine stale-fallback + tide/wave/apparent-temp/visibility/UV fields.
  - **0006:** P1 analysis (maneuver / interval / alpha / timeline / L2 corrections);
    reconciliation cron for stuck `processing`; polyline LOD; privacy enforcement once sharing
    ships; `activity_equipment` onDelete.
  - **0007 / 0008 / 0009:** whole phase deferred — design drafts done, implement when opened.

## Environment / validation (the real gating step, not a decision)

Nothing has run against live infra this session (Docker/registry was blocked). To go from
unit-tested code (142 passing) to a working backend, provision + integration-test:

- **Railway Postgres** → set `DATABASE_URL`, apply the migration (`drizzle/0000_clean_azazel.sql`).
- **Cloudflare R2** bucket + keys → `OBJECT_STORAGE_*`.
- **Clerk** keys (for real login) → `CLERK_*`.

Then a first end-to-end pass: auth (anonymous + Clerk) → spot nearby/search → weather
conditions → activity upload → metrics compute → detail.
