# Increment 0: Platform foundation

Stories in scope and how each acceptance criterion is met and proven.

| Story | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| E13-F02-S01 Event envelope and reliable delivery | Events carry ID, type, version, time, source, correlation ID, account ID and state | `EventEnvelopeSchema` (`packages/contracts/src/envelope.ts`); every event validated before it is written | `contracts.test.ts`, `events.int.test.ts` |
| | Failed events go to a dead-letter queue with alerts and can be replayed | Outbox, relay, dispatcher with back-off and dead-lettering (`packages/platform/src/events/dispatcher.ts`); `astra.events.deliveries.dead_lettered` metric, error log and the Grafana alert rule *Event deliveries dead-lettered*; replay API and workbench screen | `events.int.test.ts` (retry, dead-letter, replay, defer, rollback) |
| E13-F02-S02 Single sign-on | Roles come from IdP groups | Group-to-role map (Entra group IDs configurable); Keycloak locally, same OIDC contract as Entra ID | `auth.int.test.ts`, `authenticator.test.ts`, e2e sign-in |
| | Removed users lose access within 15 minutes | Access tokens live 5 minutes; the API refuses any token whose lifetime exceeds 15 minutes; the workbench refresh fails for disabled users and ends the session | `auth.int.test.ts` (lifetime); refresh behaviour in `proxy.ts` |
| | Multi-factor authentication | Enforced by the identity provider (Entra ID Conditional Access in Azure). Not enforced on the local Keycloak realm, by design, to keep automated tests possible | Configuration item for Increment 17 |
| E13-F02-S03 Account separation | Automated tests attempt cross-account access on every API and all attempts fail | PostgreSQL row-level security on every account table; tenancy declared on every route; the suite fails if an account route has no probe | `tenancy.int.test.ts` |
| E13-F03-S01 Tracing | One correlation ID end to end; dashboards for availability and latency | Correlation ID on responses, logs, audit and events; OpenTelemetry traces, metrics, logs; first-party `astra.api.request.duration` metric per route template; Grafana dashboard *Service health* and alert *API server errors* (quote, bind and verification routes appear as they ship) | `auth.int.test.ts` (propagation), dashboard file |
| E13-F03-S02 Delivery pipeline | Unit, contract, security, parity and accessibility checks; flags and rollback | `.github/workflows/ci.yml` (format, lint, types, unit, integration, dependency audit, secret scan, build); feature flags with per-account overrides. Parity gate joins with the rating engine; accessibility runs in `npm run test:e2e` against the local stack | CI file, `auth.int.test.ts` (flag suspends a partner) |
| E11-F01-S02 Role-based screens | Roles include product manager, rating analyst, underwriter, account manager, service rep, finance, compliance and supervisor | 11 staff roles plus partner developer; one permission matrix drives API and workbench | `auth.int.test.ts` (every staff role against every endpoint), e2e navigation test |
| E14-F01-S01 Integration patterns | Versioning, idempotency, retries, monitoring and alerts; MuleSoft confirmed before build | `docs/integration-patterns.md`; idempotency in the same transaction; `outboundFetch` with retries and circuit breaker; signed webhooks | `accounts.int.test.ts`, `webhooks.int.test.ts`, `platform.test.ts` |

## Not in this increment

- Azure infrastructure as code and private endpoints (E13-F01-S01): Increment 17.
- Rating parity gate in CI: added with the rating engine (Increment 5).
- File-transfer pattern implementation: with the first file feed (card eligibility, Increment 2).

## Verification on 19 November 2026

| Suite | Result |
|---|---|
| Unit (`npm test`) | 31 passed |
| Integration against PostgreSQL 17 (`npm run test:int`) | 55 passed: tenancy probes on every route, auth and role matrix, idempotency, accounts, webhooks (SSRF), event delivery, dead-lettering, replay, audit tamper detection, signed webhook delivery over HTTP |
| End to end with WCAG 2.2 AA (axe), desktop and mobile (`npm run test:e2e`) | 8 passed: every screen scanned, role-based navigation, account registration, sign-out |
| Production build (`npm run build`) | API, worker and workbench build |
| Live stack | Real Keycloak tokens against the API; worker relays and seals; metrics and alert rules visible in Grafana |

Defects found and fixed during verification:

- A partner could not create a webhook for its own account (row lock needed staff-only UPDATE rights); replaced by a per-account advisory lock.
- Staff-only routes validated the request body before checking access, so a partner saw a 400 instead of 403; authorisation now runs before validation.
- The CORS preflight route was caught by the tenancy guard; it is now declared public.
- Client components pulled server-only code into the browser bundle; the shared error type moved to its own module.
- Forms lost the user's input after a failed submission; values are now kept.
- Sign-out was blocked by the Content-Security-Policy `form-action` rule when redirecting to the identity provider (would also have failed with Entra ID); the IdP origin is now allowed.
- Table headers failed colour contrast and the account-menu button failed Label in Name (WCAG 1.4.3 and 2.5.3); both fixed.
- The HTTP auto-instrumentation does not record Fastify route templates; a first-party per-route metric now feeds the dashboard.
- No error screen existed when the API is unreachable; an application error boundary now shows a reference and a retry.
