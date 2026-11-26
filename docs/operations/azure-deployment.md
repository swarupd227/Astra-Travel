# Deploying to Azure

The templates are in `infra/azure`, one for every environment (`env/<name>.bicepparam`), and the workflow is
`.github/workflows/deploy.yml`. **Nothing has been deployed: no Azure subscription has been provided.** The templates
and parameter files compile (`infra/azure/validate.ps1`); everything below is untested against Azure.

## Needed from Assurant before the first deployment

| Item | Where it goes |
|---|---|
| A subscription, resource groups and naming and tagging standards | GitHub environment variable `AZURE_RESOURCE_GROUP` |
| A federated identity for the pipeline, with Contributor and User Access Administrator on the resource group | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |
| Entra ID app registrations for the API and workbench, the groups, and their mapping to roles | `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_GROUP_ROLE_MAP`, `WORKBENCH_CLIENT_ID`, secret `WORKBENCH_CLIENT_SECRET` |
| Public addresses and certificates | `API_PUBLIC_URL`, `WORKBENCH_PUBLIC_URL` (custom domains are added to Front Door) |
| Mail server | `MAIL_FROM`, secret `SMTP_URL` |
| Model access | secret `ANTHROPIC_API_KEY` (see "Claude in Microsoft Foundry") |
| Address ranges that do not collide with Assurant's network | `addressPrefix` in the parameter files |

## Secrets

Held as GitHub environment secrets and written to the environment's key vault at deployment; the applications read
them from the vault with their managed identity. Generate each per environment: `DATABASE_ADMIN_PASSWORD`,
`DATABASE_OWNER_PASSWORD`, `DATABASE_APP_PASSWORD`, `DATABASE_URL` and `DATABASE_OWNER_URL` (host from the first
deployment's output, `sslmode=require`), `SECRETS_KEK` (32 random bytes, base64), `CHANNEL_SIGNING_SECRET`,
`AGENT_TOKEN_PRIVATE_KEY` and `AGENT_TOKEN_PUBLIC_KEY` (an Ed25519 pair, base64 PEM), `WORKBENCH_SESSION_SECRET`,
`BILLING_SIGNING_SECRET`.

## First deployment of an environment

1. Run the **deploy** workflow. It creates the foundations, builds the images in the registry, deploys the
   applications and Front Door, creates the database roles and applies migrations.
2. Approve Front Door's private link requests on the container apps environment (Portal: the environment,
   Networking, Private endpoint connections). The final health check passes once they are approved.
3. Set the database host in `DATABASE_URL` and `DATABASE_OWNER_URL` if they were placeholders, and run the workflow
   again.

## Claude in Microsoft Foundry

The specification proposes Claude hosted in Microsoft Foundry. The model gateway
(`packages/agents/src/gateway.ts`) uses the Anthropic SDK with `ANTHROPIC_API_KEY`. Using Foundry needs its client
and endpoint settings added to the gateway and testing against Assurant's Foundry resource. **Not done.**

## Known differences from the specification's architecture

| Specification | These templates | Why |
|---|---|---|
| API Management | Front Door with WAF only | API Management adds the partner developer portal; add when accounts onboard by API |
| PostgreSQL per domain, Cosmos DB, Redis | One PostgreSQL server | The application uses one database with a schema per domain; no Cosmos DB or Redis code exists |
| Immutable Blob Storage for documents | Azure Files share | The application writes files to a file system; a Blob store with immutability is application work |
| Event Hubs, Service Bus, workflow engine | The platform's database outbox and worker | Not used by the application |
| Entra External ID for travellers | Not configured | Travellers do not sign in today |
| Microsoft Fabric | Not configured | Loads are written to files (ADR 0018) |
| Defender, Sentinel | Not configured | Set by Assurant's subscription policy |
| Active-active across two regions | Primary with a warm standby | See disaster recovery |
