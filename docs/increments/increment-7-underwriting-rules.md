# Increment 7: Underwriting and eligibility rules

Design: [ADR 0008](../adr/0008-underwriting-rules.md). Builds on plans and their named settings (Increment 6),
reference data (Increment 3) and the rating engine's CFAR eligibility input (Increment 5).

No Assurant underwriting guidelines, rule values or sanctions data have been provided. The tests use
invented limits, an invented referral rule and fictional sanctions entries in the published `SDN.CSV`
layout. Nothing here is a real underwriting position. The quote, bind and change journeys that call this
module arrive in Increment 9; until then the API and the workbench's eligibility check page are the callers.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E03-F01-S01 Able-to-travel declaration | Confirmation text comes from the plan's form version | Met | `POST /v1/underwriting/declarations` accepts only text found in the plan's policy form (or schedule), refusing anything else. `underwriting.int.test.ts` |
| | Confirmation, its time and the text version are stored | Met | Immutable record: confirmed, text, form edition, text hash, who, when |
| E03-F01-S02 Plan limits | A quote outside a limit returns a clear reason | Met | Minimum and maximum age, trip length and trip cost per traveller; for example "Maximum age for this plan is 75 years; this traveller is 80." |
| | Limits configured per plan and state | Met | Limits live in the plan's rule set, and plans are per state |
| E03-F02-S01 Waiver | Applies only with premium received within the time-sensitive period after the initial deposit, 100% of relevant costs insured and able to travel | Met | Three conditions, each with its own result and wording. Without a deposit date or a plan period the condition is not met and says why |
| | The decision, dates and amounts used are stored on the policy | Partly | The evaluation returns every condition with its dates and amounts; storing it on the policy comes with the policy record (Increment 9) |
| | Rating uses the waiver result | Partly | The result carries `waiver.applies` for the rating request's waiver input; the quote journey (Increment 9) connects them |
| E03-F02-S02 Explain the waiver | The policy view shows each condition and whether it passed | Partly | The eligibility check page and referral page show every condition; the policy view comes with Increment 9 |
| E03-F03-S01 CFAR | Offered only when purchase is in the time-sensitive period, able to travel, 100% insured and trip cost at or below the cap | Met | `cfar.offered` and the same decision in the shape rating already takes (`passed`, `reference`, `reasons`) |
| | A failed condition means CFAR is not offered and the reason is returned | Met | Each failed condition is a reason |
| | The notice period is stored for later checks | Met as data | Returned as `cfar.noticePeriod` from the plan's setting; the cancellation check itself is servicing (Increment 11) |
| E03-F04-S01 Prohibited destinations and sanctions | The list comes from reference data linked to the form placeholder | Met | The `prohibited_destinations` dataset in force on the departure date |
| | Travellers screened at quote and bind | Met | OFAC SDN individuals and aliases, name matching tolerant of order, case, accents and small spelling differences; date of birth raises or lowers the score |
| | A possible match holds the bind and creates a review task | Met | Outcome `held` and, with `persist`, a sanctions referral for an underwriter to clear or confirm. With no approved list loaded, a bind is held |
| E03-F04-S02 Duplicate cover | One policy per trip, except one single-trip and one annual where the plan allows | Met | Rule set option `allowSingleAndAnnual` |
| | Uses traveller identity and trip dates | Met | Normalised name and date of birth, overlapping dates, against the cover register. The register is written at bind (Increment 9) and is empty until then; results say how many register rows there were |
| E03-F05-S01 Referrals | Rules route cases to the queue with a summary | Met | Rules as data (not code); referral with the evaluation and a rule-based summary |
| | The AG-04 agent summarises | Later | Increments 12 and 15; the deterministic summary stands in until then |
| | Decision and reason returned to the channel | Met | `ReferralDecided` event with the decision; the reason is in the audit record and on the referral |
| | Declines always need a human decision | Met | A rule can only recommend a decline; only a person's decision declines, and the API refuses decisions from non-person principals |
| E03-F05-S02 Rule sets | Versioned with test cases; cannot publish while a test fails | Met | Maker-checker, immutable once approved, a stale or failing run blocks publication |
| | Each policy records the rule set version | Partly | Every evaluation returns the rule set id and version; recording it on the policy comes with Increment 9 |

## Workbench

Underwriting section: **Eligibility check** (run a case, see every check), **Rule sets** (per state or
account plan: versions, test cases, editor for limits, referral rules and options, readiness, approval,
publishing), **Referrals** (queue and decision page) and **Sanctions lists** (upload SDN.CSV and ALT.CSV,
second-person approval).

## To confirm with Assurant

- The plan limits, referral rules and options for each plan and state.
- The sanctions name-matching standard and threshold (the default 0.90 is ours, not a legal value) and
  whether other lists besides OFAC SDN (for example the consolidated non-SDN list) must be screened.
- Whether "trip cost at or below the cap" applies to the total trip cost (as built) or per traveller, and
  whether trip length counts the departure and return days (built as inclusive).
- Which referral decisions need a second underwriter.
