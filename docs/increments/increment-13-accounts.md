# Increment 13: Accounts

Design: [ADR 0014](../adr/0014-accounts.md). Builds on accounts and webhooks (Increment 0), reference data
(Increment 3), rating (Increment 5), quote and bind (Increment 9), and the agent platform (Increments 1, 8).

Everything in the tests is **synthetic**: account names, licence numbers, segments (`OTA_CRUISE`, `DIRECT`),
the contract text and the identity-provider answers. No real contract, licence, segment list or Entra ID
configuration was provided, so none is assumed.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E07-F01-S01 Guided onboarding | Captures contract, licences, segment, plans, states, integration method, rate basis and settlement terms | Met | The profile (contract, states, plans, integration, billing basis, settlement) and the checklist, judged from what is configured. `account-onboarding.int.test.ts` |
| | Cannot go live until every item is complete and tested | Met | Go-live is refused and names every open item; "tested" is true only when the account's sandbox has bound a policy through the API. Going live sets the account active and switches licence enforcement on |
| E07-F01-S02 Onboarding agent | Each drafted field shows its source | Met with a scripted model | AG-05 reads the uploaded contract and term sheet; every field carries the document and the exact wording, which the platform checks is in the document, and the value is validated. `account-onboarding-agent.int.test.ts`. **Not run against the real model**: there is no API key here |
| | I approve or correct every field | Met | The review screen: tick, correct and apply. Accepted fields are saved through the ordinary profile, segment-request and collected-variables APIs, so the same checks and approvals apply |
| E07-F02-S01 Segment | Segments come from the filed list | Met | Only codes in the approved `business_segments` reference data |
| | Needs underwriter approval and applies from an effective date | Met | An underwriter other than the requester decides; the segment in force on a date is the latest approved at or before it. Quotes use it and refuse a different one from the caller |
| E07-F02-S02 Collected variables | Each variable marked collected or not; used by the engine and shown in the worksheet | Met | A rating analyst sets the not-collected list; quotes pass it to the engine (which applies the filed "not collected" factors, or refuses when the manual gives none) and the worksheet prints it |
| E07-F03-S01 Licences | Alerts 60 and 30 days before expiry | Met | A daily worker pass raises `LicenceExpiring` once per threshold (only the tightest for a late entry); the Licences screen lists them |
| | Sales blocked in a state when a required licence expires | Met from go-live | Quote and bind are refused with the reason for an account that has gone live and holds no unexpired, unrevoked licence in the state. Accounts that have not gone live are not blocked |
| E07-F03-S02 Sandbox | Credentials and test data on signing | Partly | A sandbox twin account is created on signing; credentials are issued through the identity provider (Keycloak implemented and unit tested against a fake server; secret shown once, never stored). Entra ID issuing is not built: it is Assurant IT's to confirm |
| | The sandbox holds synthetic data only | Met | Its policies create no premium records and send no email; it never counts toward licence checks |
| | Documentation with quote, bind, change and cancel examples | Met | On the account's setup page, using the sandbox account's own ID and synthetic travellers |

## What is built

- **Database**: `onboarding` schema (profiles, segment changes, collected variables, licences and their alerts,
  contract documents, credential records) and account columns for the sandbox twin, licence enforcement and go-live.
- **API**: profile, onboarding checklist, go-live, segment changes and decisions, collected variables, licences
  (record, list, revoke), contract documents, sandbox (create, credentials issue and revoke).
- **Quote and bind** read the account's segment, collected variables and licences.
- **Worker**: the daily licence alert pass.
- **Agent**: AG-05 Account Onboarding (L2), with tools to read the profile and documents and submit a draft.
- **Workbench**: an account setup page (checklist, profile, segment, variables, licences, contract documents and
  the agent, sandbox with examples, go-live), the Licences screen, and the onboarding review on the proposals page.

## To confirm with Assurant

- How production credentials are issued in Entra ID, and whether sandbox clients are created by the platform.
- Whether card issuers and banks need licences, and which kinds per state.
- The contract wording and term sheet AG-05 should read, and which settlement terms need a structure.
- Who is told about expiring licences (the event is raised; email and webhook delivery use the existing
  subscriptions).
- Whether an account's sandbox twin should be created automatically at contract signing rather than by request.
