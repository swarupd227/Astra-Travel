# Rate manual format

A rate manual version is loaded as a JSON document (the workbench's **Rate manuals → Load manual**, or
`POST /v1/rate-manuals`). The schema is `ManualDocumentSchema` in `packages/contracts/src/rating.ts`.
Decimal values are strings (`"1.4750"`), so nothing is lost to floating point.

```json
{
  "baseLossCost": "1.475",
  "exposure": { "kind": "per_100_trip_cost", "table": "2.1.5" },
  "minimumTripCost": { "from": "1", "to": "500", "ratesAs": "500" },
  "variables": [
    { "label": "Age and pre-existing waiver", "tables": ["2.1.4"] },
    { "label": "Destination", "tables": ["2.1.9", "2.1.9b"] }
  ],
  "perilPackage": { "table": "2.1.14" },
  "exclusionWaivers": { "table": "2.1.12", "maxCombined": "1.1220" },
  "supplemental": [
    { "code": "supplemental", "name": "Supplemental benefit", "perHundred": "0.002", "threshold": "1000", "flat": "0.020", "page": "RETR-SP-VU-DE-0426-9" }
  ],
  "tables": [
    {
      "id": "2.1.5",
      "name": "Trip cost per $100",
      "page": "RETR-SP-VU-DE-0426-5",
      "keys": [{ "input": "tripCost", "match": "band" }],
      "rows": [{ "keys": [1], "factor": "…" }, { "keys": [501], "factor": "…" }],
      "unused": null,
      "unknown": null
    }
  ],
  "conversion": { "lossCostMultiplier": null, "minimumPremium": null, "roundTo": 2 }
}
```

## Tables

- **keys**: one or more rating inputs, each matched by `band` (the highest lower bound the value meets) or
  `exact`. Inputs: `age`, `preExistingWaived`, `waiverPeriodDays`, `lookbackDays`, `tripCost`,
  `tripLength`, `departureMonth` (1–12), `daysBeforeDeparture`, `destinationRegion`, `destinationScope`,
  `businessSegment`, `packageType` (`packaged` or `optional`), `penaltyDays`, `productType`. The peril
  table is keyed by `peril`, `coverageLevel` and optionally `productType` (`*` for any product); the
  exclusion waiver table by `exclusion`.
- **rows**: one per combination of keys, with its factor.
- **unused**: the filed factor when the account does not collect the variable.
- **unknown**: the filed factor when the variable is collected but unknown, or matches no row.
- **page**: the manual page, shown on every worksheet line that uses the table.

## Formula

`base loss cost × (trip cost / 100 × exposure factor) × variables × peril package × combined waivers +
supplemental benefits`, then `× loss cost multiplier`, rounded to `roundTo` places (half up), and raised
to the minimum premium. A variable with two tables (for example a region table and a
domestic/international table) uses the first one whose input the account collects. The peril package is
the sum of the percentages of the covered reasons and coverage levels, divided by 100. Combined exclusion
waivers are multiplied and capped at `maxCombined`. Supplemental benefits below `threshold` are rated per
$100 of benefit, at or above it at the `flat` amount.

Without `lossCostMultiplier`, results are **loss costs** and labelled as such.

## Points to confirm with Assurant

- How a trip cost of $0 is treated (the engine refuses it until confirmed).
- Whether the supplemental `flat` amount is a total or per $100, and the rounding steps the manual
  specifies (the engine rounds the final amount only).
- Whether combined exclusion waivers multiply (as implemented) or add.
