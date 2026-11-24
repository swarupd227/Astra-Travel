# ADR 0010: Quote, bind and the policy record (Increment 9)

Status: accepted, 24 November 2026.

## Scope

E04-F01 (quote API, re-rating on benefit changes, validation errors), E04-F02-S01/S02 (idempotent bind with
payment confirmation, state disclosures), E05-F01 (policy record, lifecycle, point-in-time view), E05-F02-S01
(trip details), E05-F03-S01/S03 (coverage dates per benefit group, annual term), E05-F04-S01 (carrier
components), E05-F05-S01 (cover verification). Not in this increment: extensions applied when triggered
(E05-F03-S02) and re-rating on trip changes (E05-F02-S01 criterion 2), which are servicing (Increment 11);
channels (E04-F03); card certificates in the policy record (E21-F01-S02, a later card increment).

## Decisions

**A quote is a stored, priced and decided offer.** `POST /v1/quotes` resolves the published plan version in
effect, rates every selected benefit for every traveller with the published manuals, evaluates eligibility
with the plan's published rule set (stage `quote`), and stores the request, the result and the versions used:
plan version, rule set version, one manual version per benefit and the disclosure version. The response gives
premium per benefit, per traveller and in total, the amount on the account's billing basis and a worksheet
reference for every line (the stored worksheet is reproducible exactly). Quotes expire; the period is a
configuration value (30 days) for Assurant to confirm.

**Selections re-rate the same quote.** `PUT /v1/quotes/:id/selection` changes the optional benefits and
re-rates in place (same quote ID, new result, version counter). Every optional benefit in the response shows
whether it can be chosen and, if not, the reason (for example CFAR conditions not met), taken from the rules
engine's result, not recomputed.

**Nothing is priced without filed rates.** A quote that would be a loss cost (no loss cost multiplier filed)
is returned and labelled, but cannot be bound. A benefit with no published manual in the state on the date is
a validation error, not a zero.

**Bind is idempotent and conditional.** It needs an `Idempotency-Key`, the traveller's able-to-travel
confirmation, the acknowledgement of the state disclosure version in force, and a payment confirmation: the
payment system's reference and an amount equal to the quote total to the cent. Eligibility is decided again at
`bind`: a referral or sanctions hold stops the bind with the referral's ID; a decline-worthy result stops it
with its reasons. A repeated key returns the original policy; another key for the same quote is refused with
the policy it already made; a payment reference is used once. The payment system itself is Increment 12; until
then the platform records the reference it is given and does not pretend to confirm it.

**State disclosures are reference data.** `state_disclosures` (state, title, text) is versioned and approved
by a second person like other reference data. The quote shows the text and version; bind stores the
acknowledgement and the version.

**The policy record is an event stream.** `policy_events` is append-only (a database trigger refuses changes).
The policy's current state is the projection of its events; the point-in-time view folds events up to a
moment. Status changes only through defined transactions: the database refuses any status change that is not
an edge of the lifecycle (`active` to `cancelled`, `expired`; nothing leaves those). The bind event holds the
full snapshot (plan, travellers, trip, benefits, premiums, components, coverage dates, review period end,
disclosure acknowledgement, payment reference, rule set and manual versions). Later transactions add events.
Times are stored as local date-times without a time zone, as the forms state them (12:01 a.m., 11:59 p.m.).

**Coverage dates come from the plan.** The plan version carries a `timing` table, keyed by benefit group (or a
single benefit, which wins): a start rule (12:01 a.m. the day after premium is received, 12:01 a.m. on the
purchase date, or departure) and an end rule (11:59 p.m. on the return date, departure, or a number of hours
before departure, as for CFAR). An annual policy ends at 11:59 p.m. on the 364th day after its effective date.
A plan with no timing for an included benefit's group cannot be quoted: the error says which. The review
period ends at 11:59 p.m. the number of days after purchase that the plan's review period setting gives.

**Carrier components.** Each plan benefit names its underwriting arrangement (VSC, ABIC or a VSC CLIP
arrangement). Premium and documents follow it; the policy stores it per benefit. How CFAR is structured
stays configurable until Assurant confirms it.

**Tenancy.** Quotes and policies belong to an account and are protected by row-level security like card
programmes; account integrations see only their own, Assurant staff see all. Cover verification is a platform
operation for authorised systems (`cover:verify`), audited on every call.

## Not decided here

The quote validity period, the review period's start and end convention, whether local times need zone
handling, and the form of the payment confirmation (the billing integration will replace the caller-supplied
reference).
