# ADR 0004: Filing register, reference data and the form library (Increment 3)

Status: accepted, 21 November 2026.

## Scope

E10-F01-S01 (filing register), E16-F01-S02 (versioned reference data) and E01-F01-S01/S02 (form library and
variable map). The configuration check against filings (E10-F01-S02) is provided here as a service and is
enforced when plans are published (Increment 6) and quotes are made (Increment 9). The Form Configuration
agent (E01-F01-S03) builds on the variable map in Increment 8.

## Inputs we do not have yet

The VSC form and schedule, the Delaware Trip Cancellation manual and Assurant's own lists are not available.
Nothing is invented in their place:

- The form library, variable maps and filing register start empty. Tests use the bracket examples quoted
  in the specification (M1), labelled as such.
- Reference datasets whose content comes from the manual or from Assurant (destination regions, business
  segments, prohibited destinations, premium tax rates) are defined with their schemas and approval flow,
  and show "awaiting source" until a version is loaded and approved.
- Public datasets are loaded from their sources: US states, the District of Columbia and territories (USPS
  Publication 28) and countries (ISO 3166-1, from the `i18n-iso-countries` package). Each version records
  its source.

## Decisions

**Platform data, not account data.** Filings, reference data and forms are Assurant's own configuration.
Their routes are `platform` tenancy: staff only, and refused to account-scoped principals.

**Reference data is versioned and effective-dated.** A dataset is defined in code (key, entry schema,
owner). A version is a complete snapshot loaded from a file or the API, validated against the schema, and
approved by a second person (maker-checker). Approved versions form a timeline per dataset: a new version
effective from a date ends the previous one on that date, and a database exclusion constraint prevents
overlaps. Lookups take an as-of date. Approved versions are immutable; each version's content is hashed.

**Filing register.** Each filing links one item (a form edition now; rate manuals and rule sets from
Increments 5 and 7, by reference until then) to a state and insurer, with the SERFF tracking number,
status (draft, submitted, approved, disapproved, withdrawn) and effective dates. Status changes are
audited. An exclusion constraint prevents two approved filings for the same item and state from
overlapping in time. `approvalFor(item, state, date)` answers whether an item may be used, with the reason
when it may not; plan publishing and quoting call it.

**Form library.** A form edition is a form number and edition (for example `trvl_indv_pol_cw`, edition
2026-05) with its kind, insurer and the filed document. PDF text is extracted on upload (pdf.js) and kept
with the page boundaries, so every variable can point at its exact location. Editions are never deleted:
policies issued on an earlier edition keep resolving it. A form edition can be used in a plan in a state
only when an approved filing for that state is in effect (E01-F01-S01 criterion 2).

**Variable map.** Each bracketed option or value is a variable of one of the seven filed types: optional
benefit, numeric range, percentage range, choice of wording, time period, limit basis and insert
placeholder. Each stores its filed minimum and maximum or allowed options, and its location in the text
(start and end offsets, with the exact excerpt, checked against the text when saved). A map is versioned
per edition and approved by a second person; approved maps are immutable. Limits replaced by upgrades
belong to the benefit catalogue (Increment 4).

**Bracket finder.** A deterministic parser lists every `[...]` and `<<insert ...>>` span in the text,
with nesting, and proposes a type and range where the wording makes it unambiguous ("$100-$10,000",
"ten (10) - fifteen (15) day", "twenty-five percent (25%) - one hundred percent (100%)"). Proposals are
suggestions a person accepts or corrects; nothing is saved without that. The Form Configuration agent
(Increment 8) is evaluated against the same structure.
