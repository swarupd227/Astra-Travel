# ADR 0001: Platform architecture for Increment 0

Status: accepted, 19 November 2026.

## Decision

- **TypeScript end to end** (Node 24). Shared contracts (`@astra/contracts`, Zod) generate validation,
  OpenAPI and the types used by the workbench.
- **Modular monolith, service-ready.** One API and one worker over PostgreSQL, with domain modules added as
  packages. Rating and eligibility verification can be deployed separately when their increments arrive.
- **PostgreSQL row-level security for tenancy.** Each transaction sets `app.account_ids`; the runtime role
  `astra_app` has no `BYPASSRLS`. Staff are platform-wide (`*`); partner principals see only their account;
  no setting means no rows. Isolation does not depend on every query remembering a filter.
- **Transactional outbox** for events, with a relay and a dispatcher that use `FOR UPDATE SKIP LOCKED`, so
  several workers can run. Delivery is at least once; consumers use the event ID to de-duplicate.
  Failed deliveries back off (10 s doubling to 1 h) and are dead-lettered after the subscriber's limit, raise
  an alert metric, and can be replayed by an operations supervisor.
- **Append-only, hash-chained audit trail.** Database triggers block update and delete; each row carries a
  SHA-256 hash; the worker seals rows into a chain; `audit.verify()` recomputes everything.
- **Idempotency in the same transaction as the change.** A repeated request replays the stored response;
  concurrent duplicates wait for the first and then replay it.
- **OpenID Connect.** The API validates access tokens (issuer, audience, signature, expiry, maximum lifetime
  of 15 minutes). The workbench is a backend-for-frontend: tokens stay in encrypted httpOnly cookies.
- **OpenTelemetry** for traces, metrics and logs, keyed by the correlation ID.

## Local to Azure mapping

| Concern | Local | Azure (Increment 17) |
|---|---|---|
| API, worker, workbench | Node processes | Azure Container Apps behind API Management and Front Door (WAF) |
| Database | PostgreSQL 17 container | Azure Database for PostgreSQL Flexible Server, private endpoint |
| Events | Outbox + PostgreSQL delivery queue | Same outbox; relay publishes to Azure Service Bus topics for cross-service consumers |
| Identity | Keycloak realm `astra` | Microsoft Entra ID (staff), Entra External ID (partners) |
| Secrets key | `SECRETS_KEK` in `.env` | Key Vault key (envelope encryption), managed identity |
| Telemetry | Grafana LGTM (OTLP) | Azure Monitor / Application Insights (OTLP) |
| Audit seals | PostgreSQL | PostgreSQL plus seal export to immutable Blob Storage |

## Consequences

- PostgreSQL 17 or later is required (`transaction_timeout` underpins safe audit sealing).
- Every new table that holds account data must enable and force row-level security with
  `platform.account_visible(account_id)`, and every new account-scoped route must be added to the
  cross-account probe suite (`apps/api/test/tenancy.int.test.ts` fails otherwise).
