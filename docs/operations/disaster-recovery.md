# Disaster recovery

Target (specification section 14): recovery point 5 minutes, recovery time 1 hour for core services, across two US
regions. **None of this has been rehearsed, and no recovery time has been measured.**

## What the design gives

| Data | Protection | Expected recovery point |
|---|---|---|
| Database, within the region | Zone-redundant standby (staging and production), point-in-time restore for 35 days | Near zero on a zone failure |
| Database, region lost | A read replica in the second region (asynchronous) and geo-redundant backups | Usually under 5 minutes of replication lag; **must be monitored and alerted** |
| Files (documents and feeds) | Geo-zone-redundant storage (staging and production) | Asynchronous; typically within 15 minutes, **which does not meet 5 minutes** |
| Secrets | Written by the pipeline to each region's vault | None lost |
| Images | Built from the commit | None lost |

The specification says active-active. The platform has a single writer database, so this is **primary and warm
standby**, not active-active.

## Standing up the standby

Deploy the same template to a resource group in the second region with the same parameter file and:
`ASTRA_PRIMARY_DATABASE_ID` set to the primary server's id (output `databaseServerId`), which creates the replica, and
`ASTRA_DEPLOY_APPS=false` until failover. Do not run migrations against a replica.

## Failing over

1. Declare the incident; stop writes to the primary if it is still reachable.
2. Promote the replica (`az postgres flexible-server replica promote`), recording the lag at the time.
3. Fail the storage account over, or point `FILE_STORE_DIR`'s share at the copy.
4. Update `DATABASE_URL` and `DATABASE_OWNER_URL` for the standby and deploy with `ASTRA_DEPLOY_APPS=true`.
5. Move Front Door's origins to the standby apps and approve the private links.
6. Check: `/health/ready`, a quote, a bind in a sandbox account, a cover verification, the audit chain
   (`POST /v1/audit/verify`), and that the worker is draining the outbox.
7. Reconcile anything accepted by the primary after the recovery point: premium records against billing, policies
   against payment confirmations.

## To do before launch

- Rehearse failover and failback, and measure both times.
- Decide whether files must meet the 5-minute point (application-level dual write, or synchronous replication).
- Pre-provision the standby's apps and private links so that step 5 does not wait on approval.
