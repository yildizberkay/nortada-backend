# Nortada Backend — RFC Index

Every RFC lives here. Format: [`0000-template.md`](0000-template.md) (each RFC uses the same
skeleton). Filename: `<NNNN>-<kebab-name>.md`. RFCs are written in English, as engineering
design documents — see the template for the required section structure.

**Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected

## Implementation steps (which RFC at which step)

Ordered by dependency. Each step builds on the previous one.

| Step | RFC | Title | Domain | Status |
| --- | --- | --- | --- | --- |
| **0** | [0001](0001-foundation.md) | Project Foundation & Architecture (scaffold, layers, DI, error/config, OpenAPI, DB, test, tooling) | platform/foundation | ✅ Completed |
| **1** | [0002](0002-identity-auth.md) | Identity & Authentication (anonymous JWT + Clerk, dual-auth middleware, anonymous→account merge) | platform/auth | ✅ Completed |
| **2** | [0003](0003-user-profile.md) | User Profile & Sport Preferences (global profile, per-sport overrides, canonical units) | platform/user | ✅ Completed |
| **3** | [0004](0004-spot.md) | Spots (model + geo nearby/search + OSM sourcing + Suggest Spot + favorites + admin) | feature/spot | ✅ Completed |
| **4** | [0005](0005-weather.md) | Weather & Conditions Decision Engine (Open-Meteo forecast/marine, per-sport verdicts + best-window, demand-driven cache + Trigger refresh) | feature/weather | ✅ Completed |
| **5** | [0006](0006-activity.md) | Activity / Session (4-layer storage, gzip track upload to S3, canonical GPS metrics, efforts, equipment) | feature/activity | ✅ Completed (P0) |
| **6** | [0010](0010-today-briefing.md) | Today Briefing (ranked top pick + alternatives + state + decision reasons, composed over favorites × conditions) | feature/briefing | ✅ Completed |
| **7** | [0011](0011-weather-map-pipeline.md) | Weather-Map PNG Pipeline (per-valid-hour layer textures — wind/temp/precip/snow — rendered from `.om` runs → R2, manifest API) | feature/weathermap | ✅ Completed |
| **8** | [0012](0012-virtual-and-private-spots.md) | Virtual & Private Spots (spot-grade verdicts for any coordinate; user-owned spots born only on alert/favorite) | feature/spot, feature/alerts | 🚧 In Progress |
| _later_ | [0007](0007-insights.md) | Insights (records, trends & aggregates across sessions) | feature/insights | 🗓️ Deferred |
| _later_ | [0008](0008-alerts.md) | Condition Alerts (subscriptions + evaluation cron + push) | feature/alerts | 🗓️ Deferred |
| _last_ | [0009](0009-subscription-notification.md) | Subscriptions (RevenueCat) & Push Notifications (APNs) | feature/subscription, platform/notification | 🗓️ Deferred |

**Deferred (user's decision, 2026-07-11):** insights is a later phase; alerts come after;
subscriptions + notifications are last (monetization last). These three now carry a full
forward-looking design, but implementation is postponed until their phase.

## Dependency graph
```
0001 foundation
  └─ 0002 auth ── 0003 user/profile
                    ├─ 0004 spot ──────┐
                    ├─ 0005 weather ───┼─ 0008 alerts (spot + weather + notification)
                    └─ 0006 activity ──┴─ 0007 insights (activity accumulation)
                                          0009 subscription + notification
```

## Source documents (what the RFCs build on)
- [NORTADA-OVERVIEW](../NORTADA-OVERVIEW.md) — what the project is
- [decisions](../decisions.md) — decision log (D-001..)
- [reference/brandscale-architecture](../reference/brandscale-architecture.md) — architecture template
- [activity-data-model](../activity-data-model.md) — session data model
- [weather-openmeteo-mapping](../weather-openmeteo-mapping.md) — weather field mapping
- [spot-model-and-sourcing](../spot-model-and-sourcing.md) — spot schema + sourcing
- [metrics-catalog](../metrics-catalog.md) — metric families
- [research/gps-tracking](../research/gps-tracking.md) — GPS upload/size research
- [otonom-kararlar](../otonom-kararlar.md) — autonomous-decision log (working notes; Turkish)
