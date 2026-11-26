# ADR 0018: Reporting model, loads to the data platform and the claims feed

Status: accepted (Increment 16b). Stories: E12-F01-S01, E12-F01-S02, E12-F01-S03, E14-F03-S04.

## Context

Neither the Artizent P&C ontology, a data platform connection nor the claims application's format has been supplied.

## Decisions

1. **The model is a set of database views with a catalogue in code.** Schema `analytics` has plans, accounts,
   policies, travellers, trips, benefits, premiums and transactions. `packages/contracts/src/data.ts` defines every
   field (type, required, personal, meaning); `GET /v1/data-catalogue` publishes it; a test fails if a view and its
   definition differ. Names are the platform's own, to be mapped to the ontology.
2. **The trip is the current trip.** `policies.current_trips` is the quoted trip until a change replaces it. Search,
   the model and the claims feed read it. (Search from Increment 15 read the quoted trip; this corrects it.)
3. **Loads are micro-batches of whatever has not been loaded.** Every five minutes the worker takes unloaded policy
   transactions and premium records (again when billing changes a record's status), writes one newline-delimited JSON
   file per entity with the current rows they touch, and records what it took. Selecting what is not yet loaded, not
   "after a number", means a change committed out of order is never skipped. One load runs at a time.
4. **Each load is checked**: required fields, unique keys, references to policies, benefit lines adding up to the
   premium, and trip dates. A failing row is left out and listed with its reason; the load is marked. The longest wait
   of any change is recorded against the 15-minute target, and the status shows what is waiting now.
5. **Personal data does not leave**: fields marked personal are never selected into a load. Sandbox accounts are not
   loaded.
6. **The destination is the platform's file store.** Delivering to a data platform is a new writer behind the same
   load; nothing pretends to be connected.
7. **The claims feed is a pull API** (`astra.claims.v1`, for the existing `cover_verifier` client): policies with
   travellers (this feed does carry names and dates of birth, which claims needs), current trip, benefits with limits
   and cover dates, and card-linked certificates with eligibility periods and the Guide to Benefits. A policy appears
   again when it changes, with a higher version. Changes are offered after a settling time (60 s) so that one still
   being committed is not passed over; consumers upsert by number and version. Reads are audited.

## Not decided

- The claims application owner's agreed format (the story requires it), and whether it wants push or files.
- The data platform, its ingestion method and credentials.
- Benefits and limits of card programmes as data: the platform holds them only in the Guide to Benefits document.
- Retention of load files.
