# Astra Travel — Architecture and Delivery Plan (draft 2)

Source documents: *Astra Travel Product Specification v0.3* and *Epics, Features and User Stories v0.3* (18 Nov 2026).

**Decisions (19 Nov 2026)**
- Stack: **TypeScript end to end** (option A in §3.2).
- Sequencing: **MVP order, story by story** — finish every P1 story in an increment before moving on; the mid-December demo shows whatever is done by then.
- Inputs available: Anthropic API key only. Form, schedule, Delaware manual, workbooks and Replit prototype are **not yet available** (§5) — increments that need them build the full capability and its tests, and load real filed content as soon as it arrives.

---

## 1. What we are building (one paragraph)

A policy management platform (not claims, not billing) for Assurant Travel with two first-class policy
types — **retail policies** (Project Voyager, VSC paper, sold via travel accounts) and **card-linked
certificates** (master policies + issuer eligibility feeds). The core loop is:
filed form → plan (Studio, M1) → filed manual → exact, explainable rating (M2) → filed rules (M3) →
quote / bind / issue (M4) → policy record (M5) → documents (M9) → premium/commission/tax/entity records
to billing (M8) → servicing (M6). Everything is versioned, linked to its filing (M10), auditable, and
operable by governed AI agents (Section 10) under human approval.

## 2. "Production grade, nothing faked" — what that means in practice

| Rule | How we apply it |
|---|---|
| No hard-coded or invented rating factors | Rate tables are loaded only from the filed manual (or an Assurant workbook). Values quoted in the spec (e.g. TC base $1.475/$100, age 45 waived 0.7200) become **test oracles**, not seed data. |
| No browser-only logic | All rating, rules, policy state and money live server-side in Postgres with real transactions. UIs call the same public APIs partners use. |
| Money is exact | Decimal arithmetic end to end (never floats); rounding only at the steps the manual specifies. Parity to the cent is a pipeline gate. |
| Estimated prices are never presented as filed | Benefits without a filed manual are rated only in `sandbox`/`demo` environments, flagged `illustrative` in the API, worksheet, UI and documents (E02-F09-S02). Production refuses to publish them. |
| External systems we don't own (billing, claims, Service Cloud, Entra, sanctions vendor) | We build the **real** interface (REST/webhook/file/event contract, retries, idempotency, control totals). Locally they point at a clearly named **conformance harness** that validates the contract — it is labelled as such in the UI and never in production config. Where a real public source exists we use it (e.g. the US Treasury OFAC SDN list for sanctions). |
| AI agents | Real model calls (Claude) behind a model gateway, real warrants checked before every tool call, real audit records. No "simulated agents". |
| Personal data | Synthetic travellers/cardholders only in non-prod. Card numbers never stored (tokens/references only). |

## 3. Proposed architecture

### 3.1 Shape
**Modular monolith first, service-ready.** One deployable backend split into strict domain modules
(own Postgres schema, own API surface, communicate via in-process interfaces + transactional outbox
events). Rating and eligibility verification are separately deployable from day one because they have
their own latency/scale targets (500 ms p95 quote; tens of millions of eligibility rows). This keeps local
development simple and maps cleanly onto Azure Container Apps later.

```
apps/
  api            – HTTP API gateway (REST + OpenAPI), auth, tenancy, idempotency
  worker         – outbox relay, event handlers, batch jobs (file bind, feeds, exports)
  rating-svc     – stateless rating engine service (manuals cached in memory)
  workbench      – staff web app (200+ users, role-based) incl. Studio, agent console
  journey        – hosted purchase journey + embeddable widget (account/bank branded)
  dev-portal     – partner API docs, sandbox credentials
packages/
  domain/*       – studio, rating, rules, policy, servicing, accounts, premium, documents,
                   compliance, card, agents, integration (pure domain logic + repositories)
  rating-core    – deterministic engine: tables, bands, formulas, worksheet (no I/O)
  ui             – design system (tokens, components, a11y), shared by all web apps
  contracts      – API + event schemas (single source → OpenAPI, TS types, validation)
infra/
  docker/        – local stack
  bicep/         – Azure (Increment 13)
```

### 3.2 Technology **[DECISION — stack]**
Recommended (option A):

| Layer | Local | Azure (later) |
|---|---|---|
| Language | TypeScript (Node 24 LTS) everywhere; `decimal.js` for money | same |
| API | Fastify + Zod contracts → OpenAPI 3.1 | Container Apps behind API Management + Front Door/WAF |
| Web | Next.js (React 19), Tailwind + Radix primitives, own design system, WCAG 2.2 AA | Container Apps / Static Web Apps |
| Data | PostgreSQL 17 (schema per domain), Redis | Azure Database for PostgreSQL Flexible, Azure Cache for Redis |
| Events | Transactional outbox → Azure Service Bus **emulator** | Azure Service Bus / Event Hubs |
| Documents | Azurite (Blob emulator), HTML→PDF via headless Chromium | Blob Storage with immutability policy |
| Identity | Keycloak as local OIDC provider (same OIDC contract as Entra) | Microsoft Entra ID (staff), Entra External ID (partners/travellers) |
| AI | Anthropic API (Claude) via model gateway | Claude in Microsoft Foundry; Azure AI Search, Document Intelligence |
| Email/SMS | Mailpit (local SMTP capture) | Azure Communication Services |
| Observability | OpenTelemetry → Grafana/Tempo/Loki | Azure Monitor / App Insights |
| Tests | Vitest, Playwright (+axe for a11y), Pact-style contract tests, k6 load | same, in CI |
| CI/CD | GitHub Actions | GitHub Actions + Bicep |

Option B: .NET 8 API + React front end (fits many insurer estates; two languages, no shared contracts).
Option C: Python (FastAPI) back end + React.

### 3.3 Cross-cutting foundations (built once, used everywhere)
- **Tenancy**: `account_id` on every row + Postgres row-level security; cross-account access tests on every endpoint (E13-F02-S03).
- **Versioning & effective dating**: every configurable thing (form, plan, manual, rule set, reference data) is an immutable version with `effective_from/to`, `state`, `filing_ref`, `status` (Draft → In review → Approved → Published → Retired).
- **Maker-checker**: generic approval workflow reused by plans, manuals, rule sets, segments, warrants.
- **Event envelope** (spec §11): id, type, version, time, source, correlationId, accountId, state; outbox + DLQ + replay.
- **Audit**: append-only audit store (hash-chained) for every command, approval and agent run.
- **Idempotency**: idempotency keys on bind and all partner-facing writes.

## 4. Delivery plan — increments in build order

Follows the backlog's MVP build order (backlog §2.3): foundation and agent platform first, card-linked
early, then Studio / Rating / Rules, then the issue path, servicing and premium, then accounts, with
workbench, compliance, data and integrations alongside. Every P1 story in an increment is finished before
the next increment starts. Each increment ends with: green pipeline, a11y checks, API docs, and a short
walkthrough for you to accept. "Needs input" marks stories whose capability we build and test fully, but
whose real filed content can only be loaded once the §5 inputs arrive.

| # | Increment | Backlog stories | Needs input |
|---|---|---|---|
| 0 ✅ | **Platform foundation** (done 19 Nov 2026, see docs/increments) — monorepo, CI with quality gates, local Docker stack, OIDC SSO + MFA-ready roles, tenancy/RLS + cross-account tests, event envelope + outbox + DLQ + replay, audit store, OpenTelemetry tracing + dashboards, design system + workbench shell, integration patterns | E13-F02-S01/S02/S03, E13-F03-S01/S02, E11-F01-S02, E14-F01-S01 | — |
| 1 ✅ | **Agent platform** (done 19 Nov 2026, see docs/increments) — registry, warrants checked before every tool call, tool catalogue over platform APIs, model gateway (Claude), guardrails, immutable run audit, kill switch, eval sets + thresholds, cost tracking | E15-F01-*, E15-F02-*, E15-F03-* | — |
| 2 ✅ | **Card-linked core** (done 20 Nov 2026, see docs/increments; plan link waits for Increment 6, volume and window still to agree) — card programmes, master policies, certificates, eligibility ledger (full/change feeds, control totals, hold-on-fail, as-of queries), payment condition (tokens only), ledger load test | E21-F01-*, E21-F02-*, E21-F03-S01 | Issuer feed format (we define a documented default) |
| 3 ✅ | **Filings, reference data & form library** (done 21 Nov 2026, see docs/increments; capability only: forms, manual tables and Assurant lists still to be provided) — filing register, versioned reference data (states, destinations/regions, 42 segments, prohibited destinations, tax tables), forms + editions + variable map (7 variable types, filed ranges, text locations) | E10-F01-S01, E16-F01-S02, E01-F01-S01/S02 | Form + schedule |
| 4 ✅ | **Benefit catalogue** (done 22 Nov 2026, see docs/increments; capability only: the schedule, policy form and peril numbers are still to be provided) — schedule benefits, sub-limits, per-day limits, deductibles, limit bases, covered reasons with coverage levels + peril numbers, upgrades incl. replacement limits | E01-F02-S01/S02/S03 | Schedule |
| 5 ✅ | **Rating engine** (5a engine core and 5b multi-benefit, CFAR/TI and billing bases done 24 Nov 2026; no filed rates loaded yet) — manual library, banded/multi-key tables, unused/unknown defaults, min trip cost rule, formula + LCM/min premium/rounding, peril package, exclusion waivers w/ max combined factor, supplemental benefits, all TC variables, derived inputs, primary destination, multi-benefit, CFAR + TI rating, rate basis conversion, worksheet (reproducible), parity harness + release gate, rating-reference guardrails | E02-F01-S01, E02-F02-*, E02-F03-*, E02-F04-*, E02-F05-*, E02-F06-S01, E02-F07-S01/S02, E02-F09-* | DE TC manual, workbook, LCM |
| 6 ✅ | **Plan builder & publishing** (done 24 Nov 2026, see docs/increments; capability only: no filed forms or manuals yet, rules and document test cases join in Increments 7 and 10) — plan builder with live range validation, packages/options, covered reason sets, coverage timing, plan conditions, state variants, account plans, maker-checker, version diff, plan test cases, filing gate | E01-F03-*, E01-F04-*, E10-F01-S02 | — |
| 7 ✅ | **Underwriting & eligibility rules** (done 24 Nov 2026, see docs/increments; capability only: no Assurant limits, rules or sanctions data provided, callers arrive with Increment 9) — able-to-travel, PEC waiver, CFAR eligibility, time-based conditions, sanctions (OFAC SDN) & prohibited destinations, duplicate cover, plan limits, referrals, rule-set versioning/tests | E03-* (AG-04 summary in Inc. 12) | — |
| 8 ✅ | **Configuration agents** (done 24 Nov 2026, see docs/increments; agents, proposals and checks built and tested with a scripted model; **not yet run against the real model**: no API key here, and no sample documents) — AG-01 Form Configuration, AG-02 Rate Manual Ingestion, AG-03 Rating Parity | E01-F01-S03, E02-F01-S02, E02-F07-S03 | Form, schedule, manual (eval sets) |
| 9 ✅ | **Quote → bind → issue → policy record** (done 24 Nov 2026, see docs/increments; capability only: no filed rates, disclosures or timing yet; extensions, re-rating on change and documents come with Increments 10 and 11) — quote API (multi-traveller, re-rate on benefit toggle, validation errors), disclosures, idempotent bind with payment confirmation, lifecycle, trip details, coverage dates, extensions, annual, carrier components, point-in-time view, cover verification API | E04-F01-*, E04-F02-S01/S02, E05-*, E21-F01-S02 (verification) | — |
| 10 ✅ | **Documents** (done 25 Nov 2026, see docs/increments; assembly, release gate, issue at bind, delivery and Guide to Benefits built and tested with synthetic forms; **AG-07 not yet run against the real model** (no API key); the filed Virginia Surety schedule and policy forms are not here; SMS and the task queue are later) — bracket-variable assembly (schedule, policy, purchase confirmation), endorsements/notices, delivery + status, Guide to Benefits, AG-07 Document Quality | E09-*, E04-F02-S03, E21-F05-S01 | Form wording |
| 11 ✅ | **Servicing** (done 25 Nov 2026, see docs/increments; preview-then-confirm changes, cancellations and corrections with refunds calculated and recorded; **AG-06 not yet run against the real model**; billing, commission clawback and reinstatement are later; state refund rules and time limits unconfirmed) — review-period cancel/refund, post-review cancel, trip date/cost changes, travellers/destination changes, upgrades, corrections; AG-06 Servicing agent | E06-F01-*, E06-F02-*, E06-F03-S01, E06-F04-S01 | — |
| 12 ✅ | **Premium records & billing integration** (done 25 Nov 2026, see docs/increments; records, allocation, tax, commission with clawback, batches with control totals and confirmations built and tested; **the billing interface, commission terms, tax schedule and daily peak were not provided**, so records needing them are held and the export is not shown at 10x peak) — premium transactions, billing bases, entity allocation, commissions (+clawback), premium tax/fees, billing interface with confirmations, high-volume export with control totals, card programme premium | E08-*, E14-F03-S01 | Billing interface spec |
| 13 | **Accounts** — onboarding wizard, segment approval, collected variables, licences/registrations with expiry alerts and sales block, sandbox credentials + docs; AG-05 | E07-* | — |
| 14 | **Channels** — embeddable widget, branded hosted journey, staff quote/issue, batch file bind | E04-F03-* | — |
| 15 | **Workbench** — policy search, unified task queue with SLA timers, agent output review, AG-04 referral summaries | E11-F01-S01, E11-F02-*, E03-F05-S01 (agent) | — |
| 16 | **Compliance, data & integrations** — audit trace export, statutory data; data model + event streaming + claims feed; reports; Service Cloud view/actions/events; sanctions, notifications, data platform; AG-09 Eligibility Feed agent | E10-F02-S01/S02, E12-F01-*, E12-F02-S01, E14-F02-*, E14-F03-*, E21-F04-S01 | Claims/Service Cloud contracts |
| 17 | **Azure** — Bicep for all environments, private endpoints, Entra ID, Foundry, deployment pipeline, DR | E13-F01-S01, NFR-01/05 | Assurant cloud standards |
| 18 | **Launch readiness** — launch-state manuals/forms, rehearsals, training, programme migration, NFR load/perf tests | E16-F01-S01, E16-F02-*, E21-F06-S01, NFR-* | Launch states, migration scope |

P2 items (E17 self-service, copilot, simulation, spreadsheet bridge, reinstatement, complaints, filing
compliance agent, cardholder view, plain-language premium explanation) follow after the MVP increments.
E20 (demo) is assembled from whatever is complete in mid-December.

## 5. Inputs we need (blockers for "nothing faked")

| # | Input | Needed by | Why |
|---|---|---|---|
| 1 | VSC Individual Travel Policy form (trvl_indv_pol_cw, ed. 2026-05) and Schedule (trvl_sch_cw, ed. 2026-04) | Inc. 1–2, 6, 10 | Variable map, benefit catalogue, document assembly. |
| 2 | Delaware TC rating manual RETR-SP-VU-DE-0426 (PDF) | Inc. 3, 6 | All tables, bands, page refs. The spec quotes only ~10 factor values; the rest cannot be invented. |
| 3 | Assurant rating workbook (if available) and the prototype rater workbook | Inc. 3 | Parity cases (workbook) / labelled illustrative loadings (prototype). |
| 4 | Replit prototype source | Inc. 14 / E20 | Spec says the demo front end builds on it. |
| 5 | Anthropic API key (local) | Inc. 5–6 | Real agent runs. |
| 6 | Loss cost multiplier (A10) | Inc. 3 | Without it the engine shows **loss cost**, labelled as such (spec §18.3). |

## 6. Working agreement

- One increment at a time; each starts with a short story-level spec + acceptance tests and ends with a demoable result and your sign-off.
- Every story's acceptance criteria from the backlog become automated tests named by story ID (e.g. `E02-F02-S01`).
- Open questions from spec §21 are tracked in `docs/OPEN_QUESTIONS.md` and surfaced when a story depends on them.
