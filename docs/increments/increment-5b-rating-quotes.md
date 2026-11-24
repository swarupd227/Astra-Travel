# Increment 5b: Multi-benefit rating, CFAR, Trip Interruption and billing bases

Builds on [Increment 5a](increment-5a-rating-engine.md). As there, no filed manuals are loaded: the CFAR and
Trip Interruption manuals in the tests are synthetic (the quoted Delaware tables with a different
exposure), because neither filed manual has been provided.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E02-F05-S01 Multi-benefit | Each benefit returns its own premium and worksheet section | Met | `POST /v1/rating/quote`: every benefit for every traveller, each with its own manual and worksheet. `quote.test.ts`, `rating.int.test.ts` |
| | Total per traveller and per policy | Met | Totals per traveller, per benefit and per policy; a quote with any rating error is refused with every problem listed |
| | Ten benefits and six travellers meet the latency target | Met | Through the API and database on a developer laptop: median 109 ms, p95 219 ms against the 500 ms target (`rating.int.test.ts` asserts p95 < 500 ms on every run) |
| E02-F05-S02 CFAR | Uses its own manual and the plan's reimbursement percentage and basis | Met | Exposure = reimbursement % (25–100) of the air or trip cost, per $100, with the CFAR manual's own tables |
| | Rated only when the CFAR eligibility rules pass | Met with an interim input | CFAR is refused without an eligibility decision and not rated when it did not pass. Until the rules engine (Increment 7) makes the decision, the caller supplies it with its reference |
| E02-F05-S03 Trip Interruption | Uses the plan's interruption limit, such as 150% of trip cost | Met | Exposure = the plan's limit % of the trip cost, per $100 |
| E02-F06-S01 Billing basis | Per policy, fixed monthly, per $100 of limit, per $100 of trip cost, per day, and combinations | Met | `toBasis`; combinations as a fixed per-policy fee plus the remainder on a basis. `quote.test.ts` |
| | Conversion method approved by actuarial and stored with the account plan | Partly | Each conversion carries its approval (who, when) and the result says whether it is approved; storing it with the account plan comes with account plans (Increments 6 and 13) |
| | The quote shows both the policy premium and the basis amount | Met | The quote result has the policy total and the basis amount, unit and method |

## To confirm with Assurant

- The fixed monthly method (implemented as premium × expected policies per month, the actuarial
  assumption) and how combinations are structured.
- Whether CFAR is insurance or a CLIP-backed waiver (specification 2.5), which affects documents and tax,
  not the rating mechanics.

## Workbench

The rating calculator takes CFAR (percentage, basis, air cost, eligibility decision) and Trip
Interruption (limit %) inputs. Multi-benefit quotes are rated through the API; their screens come with
the quote journey (Increment 9).
