# Increment 4: Benefit catalogue

Design: [ADR 0005](../adr/0005-benefit-catalogue.md).

| Story | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| E01-F02-S01 Benefits | All benefits in the sample schedule are present, including Travel Inconvenience event amounts and the medical sub-limits | The catalogue holds every kind of item the schedule has: benefits by the schedule's groups, with maximum, per-day maximum, deductible, sub-limits and event amounts (Travel Inconvenience). **Not yet met for the sample schedule itself**: the schedule (trvl_sch_cw, ed. 2026-04) has not been provided, so no benefits are loaded | `catalogue.test.ts`, `catalogue.int.test.ts` (synthetic schedule) |
| | Sub-limits are marked as included in the parent maximum benefit where the schedule says so | Each sub-limit records whether it is included in the parent maximum or paid in addition; an included sub-limit whose filed maximum is above the benefit's filed maximum is refused | `catalogue.int.test.ts`, e2e |
| | Each amount can apply per person, per trip, per reservation or per policy | Every amount has a basis: fixed, or chosen per plan through the form's limit-basis variable | `catalogue.test.ts`, `catalogue.int.test.ts` |
| E01-F02-S02 Covered reasons | Covered reasons are grouped as in the form | Each reason has its form category (for example Medical and Health, Employment and Service) and applies to Trip Cancellation, Trip Interruption or both | `catalogue.int.test.ts` |
| | Each reason holds its coverage levels | Self, family member, travelling companion, business partner, host at destination | `catalogue.test.ts` |
| | Each reason links to its peril number in the rating manual | A reason may be saved before its peril number is known, but the catalogue cannot be approved while any reason lacks one. **Peril numbers await the rate manuals** | `catalogue.test.ts`, `catalogue.int.test.ts` |
| E01-F02-S03 Upgrades | Upgrades include additional covered reason sets, Pet Package, sports upgrades and the Increased Medical Benefit Package | Upgrade kinds: covered reason set, benefit package, sports upgrade, limit replacement; each offered by an optional-benefit variable of the form | `catalogue.test.ts` |
| | When the Increased Medical Benefit Package is selected, its limits replace the base medical and evacuation limits | `effectiveLimits` applies an upgrade's replacement amounts (maximums, per-day limits, deductibles or sub-limits) and refuses two upgrades replacing the same limit; used by the plan builder, documents and rating | `catalogue.test.ts` |

## How it fits together

Every amount, basis and optional item is a reference to a variable in the approved variable map of the
schedule (or the policy form, for covered-reason options), checked by type when saved and again when the
catalogue is approved. Filed ranges therefore live only in the variable map. A catalogue is versioned per
schedule edition, approved by someone who did not build it, and immutable once approved (enforced by a
database trigger); a new version starts as a copy of the approved one.

## Workbench

**Forms & schedules → a schedule edition → Benefit catalogue**: benefits by group with their sub-limits
and amounts (showing each variable's filed range), covered reasons by category with coverage levels and
peril numbers, upgrades with what they add or replace, the problems that block approval, and
maker-checker approval. Editors offer only the variables whose type fits each field.

## Fixed along the way

The bracket finder grouped an amount with the limit bases after it (`[$10,000-$500,000] [PER PERSON]
[PER TRIP]` became one "choice of wording"). Adjacent brackets now group only when each is a plain
alternative; ranges and optional benefits stand alone.

## Waiting on inputs

- The VSC schedule and policy form, to build the real variable maps and catalogue.
- The rate manuals' peril tables, for the peril numbers (and the rating engine in Increment 5).
