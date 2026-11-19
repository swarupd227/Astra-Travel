# Astra Travel

AI-native travel policy management platform for Assurant: retail travel (Project Voyager) and card-linked cover.

- Plan and increments: [docs/DELIVERY_PLAN.md](docs/DELIVERY_PLAN.md)
- Run it locally: [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)
- Architecture decisions: [docs/adr](docs/adr)
- Integration patterns for partners and Assurant systems: [docs/integration-patterns.md](docs/integration-patterns.md)
- What each increment delivered, story by story: [docs/increments](docs/increments)

## Repository layout

```
apps/
  api/         Platform REST API (Fastify, OpenAPI at /docs)
  worker/      Event relay and delivery, webhooks, audit sealing, housekeeping
  workbench/   Staff workbench (Next.js), signs in through OpenID Connect
packages/
  contracts/   API, event and access-control contracts shared by all apps
  platform/    Server kernel: tenancy, outbox, audit, idempotency, flags, secrets, resilience, telemetry
db/migrations/ Ordered SQL migrations (PostgreSQL)
infra/docker/  Local stack: PostgreSQL, Keycloak (OIDC), Grafana LGTM (OpenTelemetry)
```
