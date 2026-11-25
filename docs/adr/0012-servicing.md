# ADR 0012: Policy servicing (Increment 11)

Status: accepted, 25 November 2026.

## Scope

E06-F01 (review-period cancellation and refund, cancellation after the review period, commission clawback),
E06-F02 (trip date, trip cost, traveller and destination changes, adding benefits), E06-F03-S01 (corrections)
and E06-F04-S01 (the Policy Servicing agent, AG-06). Not in this increment: reinstatement (P2), the commission
clawback itself and the refund payment (both belong to premium records and billing, Increment 12), and
extensions triggered by delay or hospitalisation (E05-F03-S02).

## Decisions

**Every servicing transaction is previewed, then confirmed against the price shown.** `POST
/v1/policies/:id/servicing/preview` re-rates and re-screens the change and returns what would change, the
premium before and after, and what is charged or refunded and why. `POST /v1/policies/:id/servicing` applies the
same request only if the confirmed premium change equals the recomputed one, otherwise it refuses with `409`
(the price moved) so nobody confirms a price they did not see. Both need the policy to be active.

**A change re-rates with the versions the policy was bound with.** The plan version, rule set and rate manuals
pinned at bind are used again, rated on the original purchase date, so a change is priced by the same filed
rates and the time-sensitive tests still measure from purchase. Eligibility, sanctions and prohibited
destinations are evaluated again on the new facts. A change that would lose the pre-existing condition waiver
or CFAR eligibility the policy was sold with, or that is ineligible, held or referred, is refused with the
reasons; a new policy is the route for those. (Whether to refer instead of refuse is for Assurant to confirm.)

**The record changes through events, as before.** A change is a `details_changed` event whose patch holds the
new travellers, trip, benefits, premium, term, waiver and CFAR; a cancellation is a `status_changed` event. The
policy row's term and premium columns, which feed lists and search, are allowed to follow the record (the guard
still forbids every other change); the traveller, benefit and duplicate-cover tables are kept in step in the
same transaction. Each transaction issues its change or cancellation notice (Increment 10).

**Refunds are calculated here and only recorded.** The calculation is a pure function of the policy, the plan and
the date: within the review period, with no loss confirmed by the requester, the premium is refunded in full;
the review period ends at departure; with a loss, or after the review period, the premium is non-refundable
unless the plan says otherwise. The plan's new `servicing` block holds that "otherwise" (`postReviewRefund`:
`none`, the filed sample form's rule and the default, or `pro_rata` by unexpired days for a state whose rule
differs), the time limit for insuring additional trip cost (`additionalCostDays`) and for adding a benefit
after purchase (`addBenefitDays`), each unset until Assurant confirms the rule. The amount is stored on the event
and published (`PolicyChanged`, `PolicyCancelled`); billing consumes it in Increment 12. A reduction in premium
from a change (a shorter trip, a removed traveller) follows the same refund rule.

**Corrections are limited and logged.** A correction may change a traveller's name or date of birth, the
purchaser's name or email, and the supplier. A reason is required, the event records who and why, and a
correction that changes the rating (an age moving across a band) is re-rated like any change.

**AG-06 Policy Servicing (L3 within limits) acts only through the same two endpoints.** It previews, tells the
person the change and the price, and applies only after the person who asked has confirmed in the conversation;
its warrant limits the transaction types and the size of premium change or refund; anything outside goes to the
review queue. Its changes are marked with the agent as the actor, and `GET /v1/servicing/agent-sample` draws the
weekly random sample of them for review (E06-F04-S01). Its model behaviour is tested with a scripted model only,
for the same reason as the other agents.

## Not decided here

The post-review refund rule per state, the time limits, whether a waiver-losing change refers instead of
refuses, and whether a refund is netted against later charges.
