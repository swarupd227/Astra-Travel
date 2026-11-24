# Increment 5a: Rating engine core

Design: [ADR 0006](../adr/0006-rating-engine.md). Formats: [manual](../rating/manual-format.md),
[parity cases](../rating/parity-cases.md). Increment 5b covers multi-benefit rating, CFAR and Trip
Interruption (E02-F05) and rate basis conversion (E02-F06).

No filed manual, workbook or loss cost multiplier has been provided, so **no real rates are loaded**. The
engine is tested against the values the specification and backlog quote from the Delaware Trip
Cancellation manual, held in a test fixture that cannot be published; behaviours with no quoted values
use synthetic tables marked as such.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E02-F01-S01 Manual library | Holds state, benefit, effective date, filing reference and page numbers | Met | Manual versions by code (the filing register's reference), state, benefit and dates; every table carries its page. `rating.int.test.ts` |
| | Only approved manuals in effect are used | Met | Rating uses the *published* manual in effect on the rate date; publishing needs a second analyst's approval, an approved filing in effect and full parity. `rating.int.test.ts` |
| | Older manuals remain for re-rating | Met | Versions are never deleted or changed (database trigger); any version can be rated as a labelled preview, and stored worksheets reproduce exactly |
| E02-F02-S01 Bands | Highest band whose lower bound is met; $4,200 → $4,001 band; 20 days → 15-day band; edges tested | Met | `engine.test.ts` (at the bound and one unit below) |
| E02-F02-S02 Multi-key | Age 45 waived 0.7200, not waived 0.6000 | Met | `engine.test.ts` |
| E02-F02-S03 Unused and unknown | Unused only when not collected; worksheet says why | Met | `engine.test.ts` |
| E02-F02-S04 Special rules | $1–$500 rate as $500; $0 as defined and confirmed | Met / to confirm | Rule implemented; $0 is refused until Assurant confirms the rule |
| E02-F03-S01 Formula | $1.475 per $100; trip cost factor; variables multiplied; supplemental added | Met | `engine.test.ts` (the specification's illustrative lookup, recomputed independently) |
| E02-F03-S02 Conversion | Configurable per state and benefit; rounding at the manual's steps; confirmed with actuarial | Partly | Multiplier, minimum premium and rounding per manual. Rounding is applied to the final amount only; intermediate steps wait for the manual. Settings to be confirmed with Assurant |
| E02-F03-S03 Peril package | Sum of reason and level factors; product-type factors; worksheet lists each | Met | `engine.test.ts` (Death at 3.610% / 2.704% / 0.403%) |
| E02-F03-S04 Waivers | Each waiver applies; combined never above 1.1220 | Met | Combination assumed multiplicative, to confirm; synthetic waiver factors in the test |
| E02-F03-S05 Supplemental | Per $100 below $1,000; flat at $1,000 or more | Met | Whether the flat amount is a total is to confirm |
| E02-F04-S01 TC variables | All thirteen supported; tests at every band edge | Partly | All thirteen variables are supported. Band-edge tests for every table need the filed manual |
| E02-F04-S02 Derived inputs | Trip length, days before departure, waiver period, per-person cost | Met | `engine.test.ts` |
| E02-F04-S03 Primary destination | Most travel days; domestic/international table when that is all the account gives | Met | Alternative tables per variable |
| E02-F07-S01 Worksheet | Every input, table, band, factor, step and page; stored; reproducible | Met | Stored worksheets reproduce exactly (`rating.int.test.ts`); linking to quotes and policies comes with Increment 9 |
| E02-F07-S02 Parity | Import from a spreadsheet; differences by case and factor; publishing blocked unless all match | Met | `parity.test.ts`, `rating.int.test.ts` (including stale runs) |
| E02-F09-S01 Rating reference | Parity only from manuals and Assurant workbooks; never the prototype; differences raised | Partly | Prototype sources refused; differences are recorded per run. Raising them with Assurant's actuaries is a process step |
| E02-F09-S02 No unfiled prices | Published only with a filed manual; estimated loadings only in demo and sandbox, labelled | Met | Illustrative manuals need `ALLOW_ILLUSTRATIVE_RATING` (refused in production) and can never be published |

## Workbench

- **Rating → Rate manuals**: the library; each manual's readiness checklist (approved, filed, parity,
  not illustrative), approval and publication, formula, every table with its page, and parity import,
  runs and differences.
- **Rating → Rating calculator**: rate one traveller for one benefit and see the full worksheet, using the
  published manual or a labelled preview of any version.

## Points to confirm with Assurant

The loss cost multiplier; the $0 trip cost rule; rounding steps; whether combined waivers multiply; whether
the supplemental flat amount is a total. See [manual format](../rating/manual-format.md).
