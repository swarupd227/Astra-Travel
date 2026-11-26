# Increment 16b: Data model, data platform loads and claims feed

Design: [ADR 0018](../adr/0018-data-model-loads-claims-feed.md). Everything in the tests is **synthetic**. **Nothing is
connected to an external system**: no ontology, data platform or claims application interface was supplied.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E12-F01-S01 Data model | Covers plans, accounts, policies, travellers, trips, benefits, premiums, transactions | Met | Views and catalogue; `data.int.test.ts` compares them column for column |
| | On the Artizent P&C ontology | Not met | Ontology not supplied |
| | Definitions published in the data catalogue | Met in the platform | `GET /v1/data-catalogue`; not published to an external catalogue |
| E12-F01-S02 Streaming | Events land within 15 minutes | Partly | Five-minute loads to files, with the wait measured; **no data platform to land in** |
| | Quality checks on each load | Met | Five checks, rejects listed; `data-load.test.ts`, `data.int.test.ts` |
| E12-F01-S03 Claims feed | Retail policies and certificates with travellers, trip, benefits, limits, cover dates | Met for retail; partly for card-linked | Certificates carry eligibility and the Guide to Benefits; programme benefits and limits are not held as data |
| | Format agreed with the owner | Not met | `astra.claims.v1` is a proposal |
| E14-F03-S04 Claims integration | Verification and feed live for retail and card-linked | Ready, not live | Both APIs exist; no claims application is connected |

## Correction to Increment 15

Policy search matched a trip as first quoted, so a changed destination or date was still found by the old value. It now
reads the current trip.

## To confirm with Assurant

- The ontology mapping; the data platform and how to deliver to it.
- The claims application's format and delivery, and card programme benefits and limits.
