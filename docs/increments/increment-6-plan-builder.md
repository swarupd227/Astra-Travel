# Increment 6: Plan builder and publishing

Design: [ADR 0007](../adr/0007-plan-builder.md). Builds on the benefit catalogue (Increment 4), the filing
register and form library (Increment 3) and the rating engine (Increment 5).

As before, no filed forms, schedules or manuals have been provided, so no real plan exists yet. The tests
use a synthetic schedule (benefit names from the specification, invented ranges) and the rate manual test
fixture that holds only the values the specification quotes.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E01-F03-S01 Build a plan | Benefits marked packaged, stand-alone optional or optional upgrade | Met | Plan document `benefits[].packaging`, which also sets the package type rating factor. Builder: Benefits card. `plans.test.ts` |
| | A value outside its filed range cannot be saved; the message shows the range | Met | `PUT /v1/plan-versions/:id` refuses it, for example "Trip Cancellation maximum must be between 500 and 10000 (filed range)." `plans.int.test.ts`, `e2e/plans.spec.ts` |
| | Wording choices only from the filed alternatives | Met | Values are checked with the variable map's filed options; the builder offers only those. `plans.test.ts` |
| E01-F03-S02 Coverage timing | Filed choices for when pre- and post-departure benefits start and end | Met | Named settings `pre_departure_start/end`, `post_departure_start/end`, each bound to a form variable so its filed options apply |
| | Extensions included with values within range | Met | Settings `extension_early_departure`, `extension_late_return`, `extension_baggage`, `extension_hospitalisation` |
| | Annual term available for annual plans | Met | `annual_term` is refused on single-trip plans |
| E01-F03-S03 Plan conditions | Review period 10–15 days; lookback 30–180 days | Met | The ranges come from the filed form wording, not from code: the specification's "[ten (10) - fifteen (15)] day review period" is read as 10–15 days. `plans.test.ts`, `plans.int.test.ts` |
| | CFAR reimbursement %, trip cost cap and notice period within filed ranges | Met | Settings `cfar_percent`, `cfar_basis`, `cfar_trip_cost_cap`, `cfar_notice_period`; rating takes CFAR % and basis from the plan |
| | Available to the rules engine and document assembly | Met as data | Settings are stored by name on each version and served by the API; rating already reads lookback, CFAR and Trip Interruption settings. The rules engine (Increment 7) and documents (Increment 10) read the same names |
| E01-F03-S04 State variants and account plans | A state variant links to that state's approved forms and manuals | Met | Publication records the schedule and policy editions with approved filings in the state, and the published manual for each rated benefit (`links`) |
| | An account plan changes values only within the base plan's bounds | Met | Values without a bound are fixed; bounded values must be within them; structure is unchanged. `plans.test.ts`, `plans.int.test.ts` |
| E01-F04-S01 Maker-checker | Publishing needs a second user with the approver role | Met | Approval needs `plans:approve` and someone who did not build or edit the draft (API and database check); publishing needs `plans:approve` |
| | Published versions cannot be edited | Met | API refuses; database trigger rejects any change of content |
| | Audit trail records changes and approvals | Met | `plan.created`, `plan_version.drafted/edited/approved/published/discarded`, test cases and runs |
| E01-F04-S02 Compare versions | Lists changed benefits, values, options and linked forms and manuals | Met | `GET /v1/plan-versions/:id/compare?with=`; drafts are compared with the forms and manuals they would be published with. Builder: Compare card |
| E01-F04-S03 Test cases | A plan cannot be published while any test case fails | Met for rating | Rating test cases (quote inputs and expected totals to the cent); a run is stale when the cases or the version change. Rules and document test cases join with those engines (Increments 7 and 10) |
| | Results stored with the plan version | Met | `plans.test_runs` per version |
| E10-F01-S02 Filing gate | Publishing a plan or manual fails if its filing is not approved | Met | Plan publication checks the form filings and the published (filed) manuals for the state and effective date; manuals were gated in Increment 5 |
| | Quotes fail with a clear reason in states without approval | Later | With the quote API (Increment 9) |

## Publishing gate

A state or account plan version is published only when all of these pass, and the failures are listed
together: approved by a second person; built on the approved catalogue; schedule and policy forms filed
and approved in the state on the effective date; a published rate manual in effect for every rated
benefit; every value within its filed range in the current variable maps; and every test case passing on
this version. Base plans are templates: approved, never published.

## Workbench

Plans (Product & compliance): plan list by kind and a New plan dialog; plan page with versions and
rating test cases; version page with the builder (benefits and upgrades, covered reasons with coverage
levels, values with filed ranges and account bounds, conditions and coverage timing, dates), the
publication checks, approval and publishing, test runs and version comparison.

## To confirm with Assurant

- Which values account plans may change on each base plan, and their bounds.
- The plan codes and naming convention.
