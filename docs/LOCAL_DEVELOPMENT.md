# Local development

Requirements: Node.js 24, Docker Desktop.

## First run

```bash
node scripts/init-env.mjs        # creates .env with generated local-only secrets
npm install
npm run stack:up                 # PostgreSQL :5433, Keycloak :8080, Grafana :3001, OTLP :4317/4318
npm run db:migrate
npm run db:seed:dev              # two synthetic sandbox accounts bound to the partner clients
```

Then, each in its own terminal:

```bash
npm run dev:api          # http://localhost:4000  (OpenAPI: http://localhost:4000/docs)
npm run dev:worker       # health: http://localhost:4100/health/ready
npm run dev:workbench    # http://localhost:3000
```

## Agents

The worker registers the agents in this build (today AG-10 Operations Copilot) as **pending** versions.
The model API key is saved in the app (sign in as `platform.admin`, **Settings > AI model connection**,
which also tests it); without a saved key the worker uses `ANTHROPIC_API_KEY` from your environment (never
put it in `.env`). To release an agent locally, sign in as `ai.governance.lead`, open **AI agents > Agent registry**, then set the warrant
(start from the one proposed in code), set a budget, evaluate the pending version and approve it. Any staff
user can then ask questions under **AI agents > Copilot**. Evaluations and questions call the real model and
cost a few cents.

If an existing `.env` predates a new variable (for example the agent signing keys), add the new ones
without rotating the others:

```bash
node scripts/init-env.mjs --update
```

On a heavily loaded machine Node's watch mode can restart the API or worker before they finish starting;
use `npm -w @astra/api run serve` and `npm -w @astra/worker run serve` (no watcher) instead. If the
workbench dev server starts reloading pages in a loop after many file moves, stop it, delete
`apps/workbench/.next` and start it again.

## Signing in

The local Keycloak realm (`infra/docker/keycloak/realm-astra.json`) has one synthetic user per role, for
example `platform.admin`, `compliance.officer`, `ops.supervisor`, `account.manager`, `underwriter`.
All of them use the password in `DEV_USER_PASSWORD` in your `.env`. Each user is in the
`astra-<role>` group, which the API maps to the role. In Azure the same mapping uses Entra ID
groups (`OIDC_GROUP_ROLE_MAP`).

Partner API access uses the client-credentials grant:

```bash
curl -s -d grant_type=client_credentials -d client_id=astra-partner-a -d "client_secret=$PARTNER_A_CLIENT_SECRET" http://localhost:8080/realms/astra/protocol/openid-connect/token
```

`astra-partner-a` is bound to *Sandbox Airline (synthetic)* and `astra-partner-b` to *Sandbox Bank (synthetic)*.
`astra-billing` is the billing system's client (role `billing_system`, only for confirming premium record batches); it needs `BILLING_CLIENT_SECRET` in `.env` and a realm re-import. `astra-claims` is the claims system's client: it has only the `cover_verifier` role, for
`POST /v1/cover-verifications`.

Keycloak reads the realm file only when the realm is first created. After pulling a change that adds
groups or clients (Increment 2 added `astra-cover-verifier` and `astra-claims`), add the new secrets to
`.env` and push the additions into the running Keycloak:

```bash
node scripts/init-env.mjs --update
```

```bash
node --env-file=.env scripts/keycloak-sync.mjs
```

## Reference data and forms

Public reference data (US states and territories, ISO countries) is loaded as drafts; a second person approves them in the workbench (Reference data), as with any version:

```bash
node --env-file=.env --import tsx scripts/load-public-refdata.ts 2026-01-01
```

Filings are recorded by state, so approve the US states first. Form editions are loaded in Forms & schedules (PDF with a text layer, or plain text, up to 25 MB).

## Card-linked cover

Eligibility feed files are stored under `var/files` (`FILE_STORE_DIR`; the API and worker must share it)
and processed by the worker. The file format is in
[docs/integration/eligibility-feed-v1.md](integration/eligibility-feed-v1.md). Issuers upload with their
client-credentials token:

```bash
curl -s -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/octet-stream" --data-binary @feed.txt "http://localhost:4000/v1/card-programmes/$PROGRAMME_ID/feeds?mode=test&fileName=feed.txt"
```

The workbench accepts uploads up to 100 MB. The feed load test (synthetic data, in its own account) runs
against the local database; stop the worker first so it does not pick up the test feeds:

```bash
node --env-file=.env --import tsx scripts/card-feed-load.ts 1000000 100000
```

## Tests

```bash
npm test                 # unit tests
npm run test:int         # integration tests against the astra_test database (stack must be up)
npm run verify           # format, lint, types, unit tests
npx -w @astra/workbench playwright install chromium   # once, for end-to-end tests
npm run test:e2e         # end to end (set E2E_LIVE_AGENTS=1 to include the live agent journey, which calls Claude) + WCAG 2.2 AA (axe); needs the stack, API, worker and workbench running and DEV_USER_PASSWORD in the environment
```

## Local webhook endpoints

Webhooks must use HTTPS to public addresses. To deliver to a receiver on your machine, set
`ALLOW_PRIVATE_WEBHOOK_TARGETS=true` in `.env` for the API and worker. The services refuse to start with
this setting when `NODE_ENV=production`.

## Observability

Grafana runs at http://localhost:3001 (user `admin`, password `GRAFANA_ADMIN_PASSWORD` in `.env`). The
*Astra Travel - Service health* dashboard shows API availability and latency by route, event delivery
outcomes and integration calls. Traces (Tempo) and logs (Loki) share the correlation ID that every API
response returns in `x-correlation-id`.
