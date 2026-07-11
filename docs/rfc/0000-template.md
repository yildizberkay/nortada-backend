# RFC-0000: <Title>

<!--
This file is the RFC TEMPLATE. New RFC = copy this file → `docs/rfc/<NNNN>-<kebab-name>.md`.
Every RFC uses this skeleton. A section that does not apply → write "N/A" (do not delete the heading).
Numbers are 4 digits, sequential. Keep the Status/Step meta table current.

RFCs are engineering design documents, not changelog notes. Write them in English, at
depth: a reader who has never seen the code should understand WHAT is built, WHY it is
built that way, HOW it behaves at the edges, and WHAT was deliberately not built. Prefer
concrete schemas, signatures, status codes, and examples over prose. For an already-shipped
RFC, describe the system as-built and keep the rationale.
-->

|              |                                                   |
| ------------ | ------------------------------------------------- |
| **RFC**      | 0000                                              |
| **Title**    | <short title>                                     |
| **Status**   | 🟡 Draft                                          |
| **Step**     | <implementation step, e.g. 2>                     |
| **Depends on** | <RFC-XXXX, or —>                                |
| **Domain(s)** | <platform/… or feature/…>                        |
| **Updated**  | YYYY-MM-DD                                         |

> **Status legend:** 🟡 Draft · 🚧 In Progress · ✅ Completed · 🗓️ Deferred · ❌ Rejected
> **Lifecycle:** set `🚧 In Progress` when implementation starts; `✅ Completed` when done. If a
> decision changes during implementation, update the RFC to match what was actually built.

---

## 1. Summary

One or two paragraphs: what this RFC delivers and the single most important design choice.
A reader should be able to stop here and know what the change is.

## 2. Motivation & Context

- **Problem.** What is missing or wrong today that makes this necessary.
- **Background.** The prior art / reference architecture / product context it builds on
  (link the relevant `docs/` files and `[[decisions]]`).
- **Goals.** The concrete outcomes this RFC must achieve (bullet list).
- **Non-goals.** What is explicitly out of scope for this RFC (bullet list) — distinct from
  §3 "Out" in that these are things a reader might *expect* here but that belong elsewhere.

## 3. Scope (In / Out)

- **In:** what this RFC produces.
- **Out:** what is deliberately deferred or belongs to another RFC (name the RFC).

## 4. Domain Model & Ubiquitous Language

The key concepts this RFC introduces and the exact terms used for them (so code, API, and
docs agree). Define each entity/value-object and its lifecycle/state machine where relevant.

## 5. Data Model (Drizzle)

For each table: purpose, the full column list with **the rationale for non-obvious columns**,
the `id` (integer identity PK) + `uid` (text uuid, public) pattern, jsonb columns typed
`.$type<JsonValue>()`, enums (`pgEnum`), unique constraints, indexes (and the query each
index serves), foreign keys + `onDelete` behavior, and relations. Note the migration
(`npm run db:gen`) and any data-backfill/ordering concerns. Canonical SI units (D-006).

## 6. API Surface (routes + OpenAPI)

First a table of all endpoints (method · path · auth · summary). Then, per endpoint:

- **Auth:** anonymous JWT / Clerk / admin / none.
- **Request:** the Zod schema (params/query/json), validation rules, limits.
- **Response:** the Zod response schema (`.describe()` + `.meta({ ref })`), success shape
  `{ data }`, and the meaningful status codes.
- **Errors:** the `GenericError` codes/reasons this endpoint can return and when.
- **Example:** a representative request/response (trimmed).

## 7. Services & Business Logic

The service methods (signatures), the algorithms and orchestration, the invariants they
enforce, and the non-obvious edge cases + how each is handled. Call out transactions,
idempotency, concurrency, and cross-domain calls (passed as explicit ports). A short
sequence description for any multi-step flow.

## 8. Background Jobs (Trigger.dev)

Tasks (`<name>.{schema,task,trigger}.ts`) or `schedules.task` crons: payload schema, what
the task does, retry/concurrency settings, where it is invoked from (services, never
routes), and idempotency/recompute story. Otherwise `N/A`.

## 9. Dependencies & Integrations

External services (Clerk, RevenueCat, Open-Meteo, S3, APNs…), the env vars they need
(`{NAMESPACE}_{SERVICE}_{CREDENTIAL}`), and dependencies on other RFCs (and what this RFC
exposes for later RFCs — seams).

## 10. Security & Privacy

Authentication/authorization model, data ownership (user-scoping), PII and sensitive data,
rate limiting, input hardening, and any threat considerations specific to this RFC.

## 11. Observability

What is logged (and at what level), what is reported as an exception vs. tracked as an
event, and any metrics/dashboards this RFC should surface.

## 12. Performance & Scalability

Expected data volumes, hot paths, index/query cost, payload sizes, and how this behaves as
usage grows (and what is intentionally deferred until it does).

## 13. Testing Strategy

Which services get co-located `*.service.spec.ts`, the critical scenarios (happy + error +
edge), what is mocked (repositories, other services, infra ports), and any integration/manual
tests that must be run before shipping.

## 14. Alternatives Considered

The main options weighed and why the chosen one won (kept short but concrete — this is where
future readers learn what was already ruled out and why).

## 15. Implementation Plan (checklist)

Ordered, checkable steps aligned with the "Adding a New Domain" checklist in `CLAUDE.md`.

## 16. Open Questions & Resolved Decisions

Open points still to be decided, and (as they resolve) the decision + a link to
`[[decisions]]` / `[[../otonom-kararlar]]`.

## 17. References

Related docs / RFCs / external sources.
