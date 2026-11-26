# ADR 0017: Audit trace, statutory data and account reports

Status: accepted (Increment 16a). Stories: E10-F02-S01, E10-F02-S02, E12-F02-S01.

## Decisions

1. **The trace is read from the records that made the thing, not from a log written for reporting.** A premium record
   holds its rating worksheets and the policy event that moved it; the policy holds its plan version and rule set; a
   document holds its template. `GET /v1/trace/premium-records/:id` and `/v1/trace/documents/:id` follow those links to
   the plan version, rule set, form editions (with file hashes), templates and variable-map versions, rate manuals,
   worksheets and every agent version that proposed something a person applied in that chain, or acted on the policy.
2. **A gap is reported, not hidden.** Anything the chain should contain that cannot be found is listed in `gaps`; an
   empty `agents` list means no agent took part.
3. **Taking a trace is audited**, with whether it was downloaded. It needs `audit:read`.
4. **Premium records are the accounting totals.** The statutory report is built from the benefit lines of the premium
   records (entity from each benefit's underwriting arrangement as stored in the record), and carries its own
   reconciliation: report premium against record premium, tax by entity against record tax, the split by billing status,
   and the numbers of any record whose lines do not add up. A premium with no underwriting arrangement is shown as
   `UNASSIGNED`, never allocated by guess. Dates are the UTC date of the transaction.
5. **Reports are computed when asked** from premium records, quotes and policies, so they are never older than the
   data (the story asks for at least daily). There is no reporting copy to refresh. Segment is the one approved and in
   force on the transaction date. Row-level security limits an account-scoped caller to its accounts. Sandbox
   accounts are excluded (they are never billed).
6. **CSV files are safe to open**: cells a spreadsheet would run as formulas are neutralised.

## Not decided

- The statutory and statistical file layouts regulators require: none was supplied, so the export is the data by
  state, entity and benefit as CSV.
- The accounting system the totals should also reconcile to: the platform reconciles to its own premium records.
- Report volumes: queries run over live tables; a warehouse copy is the data platform's job (Increment 16b).
