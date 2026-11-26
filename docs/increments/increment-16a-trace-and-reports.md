# Increment 16a: Audit trace, statutory data and account reports

Design: [ADR 0017](../adr/0017-trace-and-reports.md). Builds on premium records (Increment 12), documents
(Increment 10), servicing (Increment 11) and accounts (Increment 13). Everything in the tests is **synthetic**.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E10-F02-S01 Trace | Any premium or document traces to plan, form, manual, rule and agent versions | Met | Two trace endpoints; gaps listed; `reports.int.test.ts` |
| | The trace can be exported | Met | JSON download from the premium record and document screens; each one audited |
| E10-F02-S02 Statutory data | By state, entity and benefit | Met | Report and CSV |
| | Reconciles to the accounting totals | Met against premium records | The report checks itself and names unbalanced records. **No external accounting system or statutory layout was supplied** |
| E12-F02-S01 Account reports | Sales, premium, take-up, cancellations and refunds by account, segment, state and benefit | Met | Report, CSV and screen. Take-up is shown both as quotes that became policies and as the share of policies carrying each benefit |
| | Refresh at least daily | Met | Worked out when asked |

## To confirm with Assurant

- The statutory and statistical layouts and the accounting totals to reconcile to.
- What "take-up" means to account managers (both readings are shown).
- Whether report volumes need a reporting copy rather than live queries.
