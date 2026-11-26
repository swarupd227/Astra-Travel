# ADR 0022: Azure infrastructure as code

Status: accepted (Increment 17). Story: E13-F01-S01; NFR availability, recovery.

## Decisions

1. **One Bicep template, six parameter files.** development, test, sandbox, user acceptance, staging and production
   differ only in sizes, redundancy, retention and the firewall mode. A test environment runs the same topology as
   production. Parameter files are generated (`infra/azure/gen-params.py`) so they cannot drift in shape.
2. **Container Apps** rather than Kubernetes: three stateless apps (API, worker, workbench) and two jobs (database
   roles, migrations), with one user-assigned identity.
3. **Data services have private endpoints only**: PostgreSQL, the file share and the key vault have public network
   access disabled. The container apps environment is also closed to public traffic; Front Door Premium with the web
   application firewall reaches it over private link.
4. **The application's real needs, not the whole reference architecture**: services the code does not use are not
   created; the differences are listed in the deployment guide.
5. **No secret or tenant value is in the repository.** Parameter files read them from the pipeline environment; the
   vault is filled by the deployment.
6. **One commit, one set of images, one deployment**: images are built in the registry from the commit; migrations
   run from the API image.

## Not verified

Compiled only. Not deployed, so quotas, API versions at deploy time, the private link approval flow, the role
bootstrap script on Azure Database for PostgreSQL, and every sizing assumption are untested.
