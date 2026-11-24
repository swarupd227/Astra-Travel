# Increment 9: Quote, bind and the policy record

Design: [ADR 0010](../adr/0010-quote-bind-policy.md). Builds on plans (Increment 6), rating (Increment 5),
underwriting rules (Increment 7) and reference data (Increment 3).

Everything in the tests is **synthetic**: the rate manuals are invented one-row tables with a loss cost
multiplier of 1 so the arithmetic is easy to follow, the Delaware disclosure is made-up wording, the sanctions
entries are fictional. No filed rate, disclosure or timing has been provided, so no real policy can be priced or
bound yet. The platform refuses to bind a price that is only a loss cost (no loss cost multiplier filed).

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E04-F01-S01 Quote API | Premium per benefit, per traveller and in total, the basis amount and a worksheet reference | Met | `POST /v1/quotes`; every line has a stored, exactly reproducible worksheet. `policies.int.test.ts` |
| | 95% of quotes within 500 ms excluding network | Met on a laptop | Asserted on every run (p95 < 500 ms over 20 quotes through the API and database) |
| | The quote records plan, rule and manual versions | Met | Stored with the quote and the policy, and audited |
| E04-F01-S02 Re-rate | Changing a selection re-rates without a new quote ID | Met | `PUT /v1/quotes/:id/selection`; the revision counts changes; the versions the quote was made with are kept |
| | Unavailable options show the reason | Met | Time-conditioned benefits and CFAR show the rules engine's reason; choosing one is refused with it |
| E04-F01-S03 Validation errors | Code, message and field | Met | Every error carries `errors[{ code, field, message }]` |
| E04-F02-S01 Bind | Requires an idempotency key | Met | |
| | A repeated request returns the original policy | Met | Replay returns the stored response (header `idempotent-replayed`); another key for the same quote is refused with the policy number; a payment reference is used once |
| | Fails if premium payment is not confirmed | Met against a supplied confirmation | The payment reference and an amount equal to the premium to the cent are required. The payment system itself is Increment 12; until then the platform records the reference it is given and does not confirm it |
| E04-F02-S02 Disclosures | Bind refused without the acknowledgement | Met | The disclosure is reference data (`state_disclosures`, versioned and approved); the acknowledged version must be the current one |
| | Acknowledgement and version stored | Met | In the policy record and the audit trail |
| E05-F01-S01 Policy record | One record with plan, travellers, trip, benefits, premiums, components and history | Met | Event-sourced; the bind event holds the full snapshot |
| | Status, review period end and cover dates per benefit group | Met | |
| | Status changes only through defined transactions | Met | A database trigger allows only active to cancelled or expired |
| | Documents on the record | Later | Documents are Increment 10 |
| E05-F01-S02 Point in time | The policy at a given date and time | Met | `GET /v1/policies/:id?asOf=` folds events up to the moment; the workbench has a date and time control |
| | History shows each transaction, who and why | Met | Actor, name, reason; events are append-only |
| E05-F02-S01 Trip details | Departure and return, destinations, cost per traveller, deposit and final payment dates, supplier, penalty schedule | Met | Stored with the quote and policy |
| | Changes trigger re-rating and rule checks | Later | Servicing (Increment 11) |
| E05-F03-S01 Cover dates | Pre-departure starts as configured, CFAR ends as configured, post-departure as configured | Met | The plan's new `timing` table, per benefit group or benefit; a plan with none for an included benefit cannot be quoted, and the error says which |
| E05-F03-S02 Extensions | Early departure, late return, baggage, hospitalisation | Later | Applied when triggered: servicing (Increment 11) |
| E05-F03-S03 Annual term | 364 days, ending 11:59 p.m. | Met | Unit-tested; trips past the term are cut off at the term end |
| E05-F04-S01 Carrier components | VSC, ABIC or a VSC CLIP arrangement per plan | Met | Per benefit in the plan, stored per benefit on the policy |
| | Documents show the right company | Later | Increment 10 |
| E05-F05-S01 Cover verification | Status, benefits, limits and cover dates on a date | Met | `POST /v1/policy-verifications`, authorised systems only (`cover:verify`), audited |
| E21-F01-S02 Certificates | In the policy record, same verification service | Later | Card certificates keep `/v1/cover-verifications` until they join the policy record |

## Eligibility at bind

Eligibility is decided again at bind. A referral or sanctions hold stops the bind and names the referral
(`412`, code `referral_required` or `sanctions_hold`). An underwriter's decision settles the case: cleared lets
a later bind through, declined stops it. If the waiver or CFAR conditions have changed since the quote (the
time-sensitive period has passed), the bind is refused and a new quote is needed. The quote's price assumes
the traveller will confirm they are able to travel; bind requires the confirmation.

## Workbench

Policies: **Quotes** (list, new quote, quote page with price, benefits and cover dates, eligibility, versions,
disclosure and an optional-benefits control that re-rates) and **Policies** (search, record with history and
the "as it was on" control). Binding is not a screen: it needs the payment system's confirmation, which comes
through the API. The plan builder gains an underwriting arrangement per benefit and a cover dates section. To
try the screens with data, the synthetic stack can be seeded into a development database
(`apps/api/test/seed-synthetic-stack.int.test.ts`).

## To confirm with Assurant

- The quote validity period (30 days), and whether a quote's price is held to its original rate date at bind.
- The review period's start and end convention and the cover start and end rules per benefit group.
- Whether times need time zones (they are local date-times as the forms state them).
- What counts as the payment confirmation, and the policy number format.
- Whether an account in onboarding may sell (only suspended and closed accounts are blocked today).
