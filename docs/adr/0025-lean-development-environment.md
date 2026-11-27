# ADR 0025: A lean development environment in Azure

Status: accepted (November 2026), for development only. Changes ADR 0022 for the `dev` environment.

## Context

The first deployment uses a subscription whose tenant does not let the deploying account create Entra ID app
registrations, and the environment is for trying the platform, not for production.

## Decisions

1. **Keycloak runs in the environment** as the identity provider, with the local realm adapted for a public address
   (`infra/azure/keycloak`), its own database on the environment's PostgreSQL server and generated passwords. Only the
   workbench client and the synthetic staff users exist; no partner, claims or billing client is created.
2. **No Front Door or web application firewall.** The API, workbench and Keycloak are reached over HTTPS on their
   container apps addresses. The database, key vault and file share stay private.
3. **Small sizes**: a burstable B2s database, a Basic registry, containers of half a core, the API, worker and Keycloak
   always running.
4. **No model key or mail server at deployment.** The model key is set in the application (ADR 0024). Without a mail
   server, emailing documents fails and says so.
5. **Deployed from a machine with the Azure CLI** (`infra/azure/deploy-dev.ps1`); secrets are generated once into
   `var/azure/dev.secrets.json`, which is not committed.

Other environments keep the design of ADR 0022: Front Door with the firewall and Entra ID.

## Consequences

- The sign-in pages, including Keycloak's administration console, are on a public address, protected by long generated
  passwords and lock-out after repeated failures. Multi-factor sign-in is not configured.
- Whoever holds the secrets file holds the environment. Losing it means losing the ability to open encrypted values in
  the database.
