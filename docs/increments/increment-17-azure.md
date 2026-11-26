# Increment 17: Azure

Design: [ADR 0022](../adr/0022-azure-infrastructure.md). Guides: [deployment](../operations/azure-deployment.md),
[disaster recovery](../operations/disaster-recovery.md). **Nothing has been deployed to Azure.**

| Story / requirement | Status | Evidence |
|---|---|---|
| E13-F01-S01 All environments from infrastructure as code | Written, not deployed | `infra/azure`: six environments; template and parameter files compile with Bicep 0.49 without warnings |
| Data services have private endpoints only | Written, not deployed | PostgreSQL, storage and key vault with public access disabled |
| NFR Availability 99.95% | Not shown | Zone redundancy and several replicas are configured; nothing is measured |
| NFR Recovery 5 minutes / 1 hour | Not met as written | Warm standby, not active-active; files replicate asynchronously; not rehearsed |
| Pipeline | Written, never run | `.github/workflows/deploy.yml`; CI compiles the templates and builds the images |
| Entra ID | Parameters only | App registrations need Assurant's tenant |
| Microsoft Foundry | Not done | The gateway uses the Anthropic API |

## To confirm with Assurant

Cloud standards, subscription, network ranges, Entra ID registrations, regions, and the gaps listed in the guides.
