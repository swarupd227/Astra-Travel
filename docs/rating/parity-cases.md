# Parity cases

Parity cases come only from the filed manual and Assurant's rating workbooks; the prototype rater is never
a source (E02-F09-S01). Export the workbook's cases to CSV, one row per case, and import them on the
manual's page (or `POST /v1/rate-manuals/{id}/parity-cases?source=…&rateDate=…`, `text/csv`). Cases are
shared by every version of the filed manual; importing a case with an existing name replaces it.

| Column | Meaning |
|---|---|
| `name` | Case name, unique per manual |
| `expected_amount` | The workbook's result, compared to the cent |
| `age`, `pre_existing_waived` | Traveller age; `true` or `false` |
| `cost_per_traveller` or `reservation_total` + `travellers` | Trip cost |
| `purchase_date`, `departure_date`, `return_date`, `initial_deposit_date` | `YYYY-MM-DD` |
| `destination_region`, `destination_scope` | Region name, or `domestic` / `international` |
| `business_segment`, `not_collected` | Account segment; variables the account does not collect, separated by `;` |
| `package_type` | `packaged` or `optional` |
| `lookback_days`, `penalty_days`, `product_type` | As in the manual |
| `perils` | `PERIL:level|level;PERIL2:level`, levels `self`, `family_member`, `travelling_companion`, `business_partner`, `host_at_destination` |
| `waived_exclusions` | Exclusion codes, separated by `;` |
| `supplemental` | `code:amount`, separated by `;` |
| `factor:<step>` | Optional expected worksheet values, for example `factor:table.2.1.5` |

A run compares every case's amount to the cent and each `factor:` column to the worksheet, and shows
where results diverge. A manual can be published only when its latest run covers the current cases and
every case matches.
