# Increment 3: Filing register, reference data and form library

Design: [ADR 0004](../adr/0004-filings-reference-data-forms.md).

| Story | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| E10-F01-S01 Filing register | Each item shows filing reference, status and effective dates | One filing per item per state with insurer, SERFF tracking number, status (draft, submitted, approved, disapproved, withdrawn), submission and decision dates and effective dates; every change is in the filing history and the audit trail. A database exclusion constraint prevents overlapping approvals for the same item and state | `studio.int.test.ts` (register, history, overlap) |
| E16-F01-S02 Reference data | Reference data is versioned with effective dates | Six datasets defined with schemas. A version is a complete snapshot loaded by API (JSON or CSV), validated (including codes that refer to other datasets) and approved by a second person; approved versions form a non-overlapping timeline and never change (enforced by database triggers). Lookups take an as-of date; each version shows what it changes against the one before | `studio.test.ts`, `studio.int.test.ts` |
| E01-F01-S01 Form library | A form record holds form number, edition, state, filing reference and status | A form edition holds form number, edition, kind, insurer and the filed document (PDF text extracted page by page, or text); its filings give state, SERFF reference, status and dates | `studio.int.test.ts` |
| | Only forms with status Approved can be used in a plan | `approvalFor` / `GET /v1/form-editions/{id}/usability`: usable only while an approved filing is in effect in that state on that date, with the reason when not. Plan publishing calls it from Increment 6 | `studio.int.test.ts` (future, current, withdrawn, other states) |
| | Previous editions stay available for policies already issued on them | Editions are never replaced or deleted; a withdrawn approval still covers the dates before withdrawal | `studio.int.test.ts` |
| E01-F01-S02 Variable map | Variable types include optional benefit, numeric range, percentage range, choice of wording, time period, limit basis and insert placeholder | All seven types, each with its own schema | `studio.test.ts` |
| | Each variable stores its filed minimum and maximum, or its list of allowed options | Ranges (with unit or basis) and option lists; `checkValue` rejects values outside them (used by the plan builder) | `studio.test.ts` |
| | Each variable links to its location in the form text | Start and end offsets and the exact excerpt, checked against the edition text when saved; page shown | `studio.int.test.ts` |

E10-F01-S02 (configuration blocked when not approved) is delivered as the check service here; its two
criteria are met when plan publishing (Increment 6) and quoting (Increment 9) call it.

## Bracket finder

Reads every `[...]` span (with nesting) and `<<insert ...>>` placeholder and proposes a type and range
only where the wording is unambiguous, for example `[ten (10) - fifteen (15)] day` (time period, 10 to
15 days, reading the unit after the bracket), `[$0-$5,000,000]`, `[cruise][tour][trip]` (choice of
wording) and `[PER PERSON] [PER TRIP]` (limit basis). It is tested on every bracket example quoted in the
specification. A person accepts or corrects each proposal.

## Data loaded, and what is still awaited

| Dataset | Status |
|---|---|
| US states, DC and territories | 56 entries from USPS Publication 28 (`data/reference/us_states.csv`), loaded as a draft by `scripts/load-public-refdata.ts` |
| Countries | 249 ISO 3166-1 entries from `i18n-iso-countries` 7.14.0 (XK excluded: not an ISO code), loaded as a draft |
| Destination regions | Awaiting the filed rate manuals (for example Delaware TC table 2.1.9) |
| Business segments (about 42) | Awaiting the filed rate manuals |
| Prohibited destinations | Awaiting Assurant compliance |
| Premium tax rates | Awaiting Assurant tax |

No forms are loaded: the VSC form and schedule have not been provided. Tests use the wording the
specification quotes, labelled as such.

## Workbench

- **Forms & schedules**: library with approvals by state and map status; loading an edition; the edition
  page with its filed document, filings by state, a "can a plan use it?" check, and the variable-map
  workspace: the form text with mapped and suggested wording highlighted, suggestions to accept or
  correct, mapping any selected wording, and maker-checker approval.
- **Filing register**: search and filters, recording filings for several states at once, and each
  filing's status changes and history.
- **Reference data**: datasets with the version in force and drafts waiting, CSV loading, and each
  version's changes, entries and approval.

## Fixed from Increment 2

The card programme list counted "eligible today" in the ledger for every programme on every request.
With about 4 million ledger rows (left by the load tests) it took over 15 seconds and the cover-check
screen failed. Programmes now keep "accounts on file" and "certificates issued", recalculated exactly
when a feed is applied (migration 0007); lists show those. The exact "eligible today" is shown on the
programme page, using a new partial index.

## Roles

`refdata:manage` (rating analyst, compliance officer), `filings:manage` (compliance officer),
`forms:manage` (product manager, rating analyst, compliance officer). Every staff role can read all three.
Approvals always need a second person: whoever loaded a reference data version, or created or edited a
variable map, cannot approve it.
