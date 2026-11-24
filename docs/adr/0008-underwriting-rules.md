# ADR 0008: Underwriting and eligibility rules (Increment 7)

Status: accepted, 24 November 2026.

## Scope

E03-F01-S01/S02 (able-to-travel declaration, plan limits), E03-F02-S01/S02 (pre-existing condition waiver and
its explanation), E03-F03-S01 (CFAR eligibility), E03-F04-S01/S02 (prohibited destinations, sanctions
screening, duplicate cover), E03-F05-S01/S02 (referrals, rule sets with test cases). The quote, bind and
change journeys (Increment 9) call this module; here it is built, tested and exposed through the API.
The Underwriting Referral agent (AG-04) comes with the workbench task queue (Increments 12 and 15); until then
a referral carries a deterministic case summary built from the rule results.

## Decisions

**What is filed and what is configured.** The conditions the forms file are fixed in code, with their
numbers read from the plan: the waiver needs premium received within the *time-sensitive period* after the
initial deposit, 100% of the relevant trip costs insured, and the traveller able to travel; CFAR needs
purchase within the time-sensitive period, able to travel, 100% insured, trip cost at or below the plan's
*CFAR cap* and cancellation at least the *notice period* before departure. The period, cap and notice come
from the plan version's named settings (Increment 6), so rules, rating and documents use one value. What
Assurant underwriters configure, per plan, lives in a **rule set**: plan limits, referral rules, benefits
that need purchase within the time-sensitive period, the sanctions match threshold, duplicate-cover options
and whether prohibited destinations and the able-to-travel declaration apply.

**Rule sets** belong to a state or account plan and are versioned (draft, approved, published, superseded)
with the same discipline as plans: a second person approves, approved and published versions never change,
one published version per plan and date range, and **a version is published only when every one of its test
cases passes** on the current content. Each evaluation returns the rule set version it used so the policy
can record it (Increment 9).

**Referral conditions are data, not code.** A rule is a JSON expression tree (`all`, `any`, `not`, and
comparisons of a named field with a value). The fields are a fixed list (traveller age, trip days, cost per
traveller, total trip cost, number of travellers, destination country and region, business segment, days
before departure, insured percentage). Nothing is evaluated as a script.

**Outcomes.** `eligible`; `ineligible` (a plan limit or prohibited destination, with a clear reason for
each); `referred` (a referral rule fired); `held` (a possible sanctions match). A rule can *recommend* a
decline, but a decline is always decided by a person: the engine never declines through a referral rule.
Referrals are stored with the evaluation, the rule set version and a summary, and an underwriter approves
or declines with a reason. A held case is a referral of kind `sanctions`; approving it clears the match.

**Sanctions screening.** The list is the US Treasury OFAC Specially Designated Nationals list, loaded from
its published `SDN.CSV` (and optionally `ALT.CSV` for aliases) as a versioned list that a second person
approves. Matching is on normalised names (case, accents, punctuation, word order) with token similarity;
a date of birth that disagrees with a dated entry lowers the score and one that agrees raises it. A score
at or above the rule set's threshold is a *possible match*, which holds the bind. The threshold is a
configured value, not a legal one: Assurant compliance confirms it. Nothing is downloaded by the platform
on its own; compliance uploads the file, so what was screened against is on record.

**Prohibited destinations** come from the reference dataset of that name (Increment 3), in force on the
trip's departure date, so they are the same list the policy form placeholder is filled from.

**Duplicate cover** looks for another active cover for the same traveller (normalised name and date of
birth) whose dates overlap the trip, in the cover register. The register is written when a policy is bound
(Increment 9); until then it is empty and the check finds nothing, which is stated in the result. One
single-trip and one annual policy may coexist when the rule set allows it.

**Declaration.** The able-to-travel confirmation records the plan version, the notice text, the hash of
the form edition the text was found in, the confirmation, who recorded it and when. The text must appear in
the plan's policy form (or schedule), so it is always the filed wording.

## Not decided here

Whether the OFAC threshold, the referral rules and the plan limits match Assurant's underwriting
guidelines (we have none yet; the tests use invented values), and the exact name-matching standard
Assurant compliance requires. Both are marked for confirmation.
