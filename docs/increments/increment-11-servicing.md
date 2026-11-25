# Increment 11: Servicing

Design: [ADR 0012](../adr/0012-servicing.md). Builds on quote, bind and the policy record (Increment 9),
documents (Increment 10), underwriting rules (Increment 7) and the agent platform (Increments 1, 8).

Everything in the tests is **synthetic**: the stack's TCAN rate is 2.000 per $100 of trip cost, so a trip cost of
4200 rates at 84.00 and 5000 at 100.00. No state refund rule other than the filed sample form's has been
provided, and Assurant has not confirmed the time limits for adding cost or benefits, so those are plan settings
that default to the sample form's rule and to "no limit beyond the rules engine".

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E06-F01-S01 Review-period cancellation | Full refund within the period, before departure, with no loss | Met | `cancellationMoney` and `reviewStatus` (unit tested); the requester confirms "no loss" on the request. `servicing.int.test.ts` |
| | The period ends automatically at departure | Met | The period ends at the earlier of its end date and the start of the departure date |
| | Refund amount calculated and sent to billing | Partly | The amount is on the policy event and published as `PolicyCancelled` / `PolicyChanged`. Billing consuming it is Increment 12 |
| E06-F01-S02 After the review period | Non-refundable under the sample form | Met | The plan's `servicing.postReviewRefund` defaults to `none` |
| | A state rule that differs overrides | Met | Set `pro_rata` on the plan (unexpired days); no state's rule has been loaded, because none was provided |
| E06-F01-S03 Commission clawback | Follows account rules, in the next statement | Later | Premium records and commission are Increment 12; the refund amount it needs is on the event |
| E06-F02-S01 Trip dates | Re-rated, difference shown before confirming | Met | Preview, then confirm against the price shown (`409` if it moved) |
| | Coverage dates move with the trip | Met | Cover dates per benefit and the policy term are recomputed from the plan's timing |
| E06-F02-S02 Trip cost | Re-rated; waiver and CFAR re-checked | Met | The rules engine runs again; a change that would lose the waiver or CFAR eligibility is refused with the reason |
| | Time limit for insuring additional cost | Met, limit unset | `servicing.additionalCostDays`, null until Assurant confirms |
| E06-F02-S03 Travellers and destinations | Each change re-rated and re-screened | Met | Sanctions, prohibited destinations, limits and referral rules run again; a possible sanctions match, a referral or an ineligible result refuses the change |
| | Removing a traveller follows refund rules | Met | The reduction is refunded in the review period (when no loss is reported) and kept after it, unless the plan refunds |
| E06-F02-S04 Add an upgrade | Only within any time limit in the form | Met, limit unset | `servicing.addBenefitDays`, and the rules engine's own availability (time-sensitive period, CFAR conditions) |
| E06-F03-S01 Corrections | Logged with a reason | Met | Names, date of birth, purchaser and supplier; a reason is required and kept on the event |
| | Corrections that change premium are re-rated | Met | A date of birth change re-rates |
| E06-F04-S01 Servicing agent (AG-06) | Confirms the change and price before acting | Met with a scripted model | The preview is read-only; applying needs the requester's confirming words, which the platform checks are in the requester's own message. `servicing-agent.int.test.ts` |
| | Requests outside its warrant go to the queue | Met | Other transaction types and amounts above `AGENT_SERVICING_MAX_AMOUNT` (500, to be confirmed) are queued as a review of kind `servicing_request`; out-of-warrant tools raise the existing warrant review |
| | A weekly sample of agent changes is reviewed | Met | `GET /v1/servicing/agent-sample` and the Agent changes screen |
| Reinstatement | Only if rules allow and no loss | Later | P2 |

**AG-06 has not been run against the real model**: there is no API key in this environment.

## What is built

- **Money rules** (`packages/policies/src/servicing.ts`): review status, cancellation refund, change charge or refund,
  time limits; whole-cent arithmetic.
- **Engine and API**: `POST /v1/policies/:id/servicing/preview` and `POST /v1/policies/:id/servicing` (idempotent,
  needs the price shown). A change is an event on the policy; the policy row's term and premium, the traveller and
  benefit tables and the duplicate-cover register follow in the same transaction; the notice is issued with the
  documents of Increment 10.
- **Plan**: a `servicing` block (refund rule after review, additional-cost and add-benefit limits). Plan versions
  saved earlier have none and get the defaults. The plan builder has no screen for it yet: it is set through the API.
- **Workbench**: "Service this policy" on the policy page (choose the transaction, see what changes and the price
  and the rule behind it, then confirm), and the Agent changes sample.

## To confirm with Assurant

- The refund rule per state after the review period, and which states differ.
- The time limits for insuring more trip cost and for adding benefits after purchase.
- Whether a change that would lose the waiver or CFAR eligibility should refer to an underwriter instead of being refused.
- The agent's limits (types, amount) and who reviews its sample.
- Whether a reduction after the review period keeps the difference or credits it against later changes.
