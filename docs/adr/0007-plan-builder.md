# ADR 0007: Plan builder and publishing (Increment 6)

Status: accepted, 24 November 2026.

## Scope

E01-F03-S01..S04 (building plans, coverage timing, plan conditions, state variants and account plans),
E01-F04-S01..S03 (maker-checker publishing, version comparison, plan test cases) and the publishing half
of E10-F01-S02 (configuration blocked when not filed). Quoting (the other half) uses the published plans
from Increment 9.

## Decisions

**Three kinds of plan.** A *base plan* is a template built from an approved benefit catalogue; it is
approved but never sold. A *state plan* is a variant of a base plan for one state; it links to that
state's approved form editions and published rate manuals and is what gets published. An *account plan*
is derived from a published state plan for one account and may change only the values the base plan
leaves open, within the bounds it sets (E01-F03-S04).

**A plan version is a validated document** holding:
- *benefits*: catalogue benefits included, each marked packaged, stand-alone optional or optional upgrade
  (this drives the package type rating factor), and the rate manual benefit code that prices it (for
  example TCAN);
- *upgrades*: catalogue upgrades offered, with their packaging;
- *covered reasons*: the Trip Cancellation and Interruption reasons included and, for each, the coverage
  levels covered (a subset of the reason's levels); they give the peril package for rating;
- *values*: a value for every form variable the plan uses (amounts, bases, wording choices, periods),
  keyed by `schedule:key` or `policy:key`, each checked against the variable's filed range or options as
  it is saved, with the allowed range in the message;
- *settings*: named plan conditions and coverage timing (review period, time-sensitive period, lookback
  period, CFAR reimbursement percentage, basis, trip cost cap and notice period, Trip Interruption limit,
  start and end of pre- and post-departure cover, extensions, annual term). Each setting binds a form
  variable, so its filed range applies; rules (Increment 7) and documents (Increment 10) read settings by
  name, so all three use the same values;
- *bounds* (base plans only): for each value an account may change, the narrower range or options
  allowed.

**Versioning and approval.** One draft per plan at a time; a new draft copies the current version.
Approval needs a second person with `plans:approve` who did not create or edit the draft. Approved and
published versions never change (database trigger). Every change and approval is audited, and any two
versions can be compared: benefits, packaging, reasons, values, settings and linked forms and manuals.

**Publishing gate (state and account plans).** Publishing an approved version checks, for its effective
date: the catalogue version is approved; the schedule and policy form editions have approved filings in
effect in the plan's state; every rated benefit has a published rate manual in effect for the state;
every value is within its filed range in the current variable maps; and every plan test case passes.
Failures are listed together; nothing is published until all pass.

**Test cases.** A plan's rating test cases are quotes (travellers, trip and account inputs) with the
expected total per benefit or per policy, to the cent. The plan supplies everything else: package types,
peril package, lookback period, CFAR and interruption settings. A test run is stored with the plan
version; a version cannot be published while any case fails or has not been run since it changed. Rules
and document test cases join when those engines exist (Increments 7 and 10).
