# Increment 2: Card-linked cover core (epic E21)

Design: [ADR 0003](../adr/0003-card-linked-cover.md). Feed format:
[eligibility-feed-v1](../integration/eligibility-feed-v1.md).

| Story | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| E21-F01-S01 Programme set-up | A programme links to a master policy, a plan, states, effective dates and the payment condition | Programmes are owned by the issuer's account and link to a master policy, states (within the master policy's), effective dates (within the master policy's), the payment condition and the eligibility rule. **Not yet linked to a plan**: plans are published by the plan builder (Increment 6); the link is added there | `card.int.test.ts` (set-up, states outside the master policy) |
| | A programme cannot go live until its eligibility feed has passed testing | Programmes start in draft; live feeds are refused for drafts; `go-live` requires a passed test feed and an active master policy. Test feeds are parsed, checked and classified against the ledger but never applied | `card.int.test.ts` (go-live gate, test feeds never touch the ledger) |
| E21-F01-S02 Master policies and certificates | Certificates link to their master policy and programme | One certificate per cardholder account per programme, numbered `<programme code>-<9 digits>`, issued by the feed that first made the account eligible | `card.int.test.ts` |
| | Certificates use the same cover verification service as retail policies | `POST /v1/cover-verifications` takes a `type`; `certificate` is implemented now and `policy` joins it with quote, bind and issue (Increment 9) | `card.int.test.ts` (cover verification) |
| E21-F02-S01 Feed loading | Each feed is validated against control totals | Trailer counts (records, adds, updates, removes) must match; structure errors (header, version, trailer, data after the trailer) are fatal | `parser.test.ts`, `card.int.test.ts` |
| | A failed feed is held and the previous version stays in force | Fatal errors, a share of rejected records above the programme's threshold, or a first live feed that is not full hold the feed: nothing is applied. Feeds apply exactly once (SHA-256) and strictly in sequence; a later sequence waits. A held feed is rejected by a person to free its sequence for a corrected file | `card.int.test.ts` (hold, sequence order, replayed sequence) |
| | The load reports accepted, rejected and changed records | Each feed records records, rejected, added, updated, removed, unchanged and certificates issued, plus the rejected lines with reasons (card numbers never stored) | `card.int.test.ts`, feed screen |
| E21-F02-S02 Eligibility on a date | The answer uses the eligibility version in effect on the purchase date and the loss date | The ledger never overwrites: a change ends the current period and starts a new one from the feed's as-of date, so earlier answers stay reproducible | `card.int.test.ts` (as-of answers before and after a change) |
| | The answer shows the feed version that supports it | Each answer names the feed (ID, sequence, as-of date) that established the period covering the date | `card.int.test.ts` |
| E21-F02-S03 Scale | Load tests cover the agreed volume with daily change feeds processed within the window | Set-based staging and apply in one transaction; streaming parse; see the measurements below. The agreed volume and processing window are not yet agreed with Assurant | `scripts/card-feed-load.ts` |
| E21-F03-S01 Payment condition | The condition (full or partial payment with the card or account) is configured per programme | `none`, `full`, or `partial` with a minimum percentage; checked in whole cents | `parser.test.ts` (boundaries), `card.int.test.ts` |
| | Card numbers are never stored. Only tokens or account references are used | Luhn-valid 13 to 19 digit references are rejected in feeds (value not stored, not even in the rejection), in eligibility checks and in cover verification | `parser.test.ts`, `card.int.test.ts` (no card number in any table) |

## Claims system access

The claims application calls `POST /v1/cover-verifications` with its own client (`astra-claims` locally,
an Entra ID app registration in Azure). Its token carries only the `cover_verifier` role, which grants
only `cover:verify`; a token cannot mix machine and person roles. Every verification is in the audit
trail with the client as a `system` actor, the dates asked about, the answer and the feeds behind it.

## Workbench

- **Card programmes**: list with eligible accounts today, certificates and last applied feed.
- **Programme**: terms, held or waiting feeds called out at the top, feeds with their results, feed
  upload (test or live), eligibility check, go-live and status changes.
- **Feed**: file details (size, SHA-256), result counts, rejected lines, and rejecting a held feed.
- **Master policies**: list and registration.
- **Cover check**: the claims answer for staff with `cover:verify`.

## Load test

`scripts/card-feed-load.ts` runs a full feed and then a change feed (40% adds, 40% updates, 20% removals)
through the worker's processor against PostgreSQL 17 in Docker on a developer laptop that was also running
other projects' containers. Measured 20 November 2026, with about 3 million ledger rows already present:

| Feed | Records | File | Time | Rate | Phases |
|---|---|---|---|---|---|
| Full (first load) | 1,000,000 | 32 MB | 99 s | 10,100 records/s | stage 27 s, validate 1 s, plan 11 s, apply 56 s |
| Change | 100,000 | 3.5 MB | 12.5 s | 8,000 records/s | stage 3 s, validate 2 s, plan 2 s, apply 5 s |
| Eligibility lookup | — | — | 2.3 ms average | — | 1,000 random accounts |

What changed while measuring, and why:

- The first run took 202 s for the full feed. Query plans showed that per-row foreign-key checks were about
  80% of apply time, so the two ledger tables no longer carry foreign keys; `card.verify_ledger()` checks
  their references instead (asserted in the integration tests), and the application role cannot delete the
  programmes and feeds they point to.
- A change feed applied straight after a large load took over two minutes for 20,000 records, because
  autovacuum had not yet analysed the new rows and the planner chose a nested loop over the whole
  programme. Each apply now refreshes the ledger statistics first (a sampled `ANALYZE`); the same feed takes
  1.5 s.

Not yet proven: the backlog asks for "the agreed volume" within "the window", and neither is agreed with
Assurant. Linear extrapolation gives about 17 minutes for a first full load of 10 million accounts and
about 2 minutes for a 1 million-record daily change feed on this laptop; those figures are estimates, not
measurements. The run is repeated at the agreed volume on Azure Database for PostgreSQL (Increment 13)
before go-live.

## Notes

- Feed files are kept in the file store (`var/files` locally, Blob Storage in Azure). SFTP delivery is
  the Azure pattern; locally and for issuers who prefer it, the upload API is used.
- Workbench uploads are limited to 100 MB because server actions buffer the file; larger feeds use the
  API, which streams to storage (default limit 4 GiB).
- Issuers' integration developers (`partner_developer`) can read their own programmes and upload feeds;
  setting up programmes, going live and rejecting held feeds are Assurant staff actions.
