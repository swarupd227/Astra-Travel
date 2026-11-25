# Increment 12: Premium records and the billing interface

Design: [ADR 0013](../adr/0013-premium-records-billing.md). Builds on quote and bind (Increment 9), documents
(Increment 10) and servicing (Increment 11).

Everything in the tests is **synthetic**: the stack's TCAN rate is 2.000 per $100 of trip cost (84.00 for a trip
cost of 4200), and the premium tax rates (2% VSC, 3% ABIC), commission percents and the programme rate are test
values, not filed or contracted ones. **No billing system, commission terms or tax schedule has been provided**:
nothing is assumed, and records that need what is missing are held, with the reason.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E08-F01-S01 Premium record per transaction | A record for every bind, change, cancellation and refund | Met | Written in the same transaction as the policy event (`bind`, `change`, `cancellation`; a refund is a record with a refund amount). `billing.int.test.ts` |
| | Amounts per benefit, per traveller and per policy | Met | Spread by largest remainder so each view sums to the record's total exactly |
| | Unique ID, link to the transaction and the rating worksheet | Met | Unique number and ID, the policy event's sequence, the worksheets of the quote or re-rate |
| E08-F01-S02 Billing basis | Per policy, fixed monthly, per $100 of limit, per $100 of trip cost, per day, combinations; basis and calculation in the record | Met as rated | The quote already expresses the amount on the account's basis (Increment 5b); its basis and calculation are copied into the record. Billing the account's basis amount rather than the premium is for the billing system to read from the record |
| E08-F01-S03 Entity allocation | By VSC, ABIC or CLIP; entities always equal the total | Met | From each benefit's underwriting arrangement; a benefit without one holds the record |
| E08-F02-S01 Commission | Flat, tiered and volume rules | Met | Per account, effective-dated, approved by a second person; an account can be set to pay none |
| | Clawback on refunds | Met | At the effective rate of the original bind record; the whole life of a cancelled policy nets to zero |
| E08-F02-S02 Premium tax | Configurable by state, entity and date | Met | The `premium_tax_rates` reference data (versioned, effective-dated, approved); no rate loaded holds the record. Whether tax is on top of premium or inside it is not stated: it is reported, not added |
| E08-F03-S01 Send to billing | Through the agreed interface | Partly | The interface is not agreed. A file drop and a signed HTTP push are built, with one batch format |
| | Confirmed receipt; unconfirmed retried and alerted | Met | Resent with the same batch ID after a timeout, then marked `unconfirmed` and an event raised; staff can retry |
| | No record sent twice | Met | A record's batch is set once and the database refuses to change it |
| E08-F03-S02 Confirmations | Refund status shown on the policy | Met | Premium records card on the policy page, with each record's status and billing's reference |
| | Bind completes only when payment is confirmed where the plan requires it | Not changed | Bind already needs the payment system's reference and an exact amount from its caller; waiting for billing's own confirmation needs the interface |
| E08-F04-S01 High volume | Batches or a stream; counts and totals checked by billing | Met | Header and trailer carry the control totals; billing's confirmation is compared and a difference marks the batch `mismatch` and alerts |
| | Ten times the measured daily peak in the agreed window | Not shown | No daily peak or window has been measured or provided. The measured rate here is **about 1,400 records per second** for building and writing a batch of 20,000 on a developer laptop, streamed in pages |
| E08-F04-S02 Programme premium | On the programme's basis, such as per account per month | Met for that basis | A rate per eligible account per month, accounts counted on the month's last day from the eligibility ledger; same batches as retail premium. Tax and commission are not calculated on programme records |
| E14-F03-S01 Billing integration | Premium, commission, tax and refund records sent, confirmations received | Partly | As above; a client-credentials role for the billing system (`billing_system`) is added, with a Keycloak client `astra-billing` |

## What is built

- `packages/billing`: allocation, premium tax, commission with clawback, control totals, batch format (unit tested).
- Database: `billing.premium_records` (immutable, held records recalculable), `commission_rules`,
  `programme_rules` (both approved by a second person), `batches`.
- API: records, rules, programme premium, batches (create, list, file, retry), confirmations.
- Worker: sends batches (file drop with a control file, or signed HTTP push), resends, alerts.
- Workbench: Premium records, record page, Batches, Commission and programme rules, and a Premium records card
  on each policy. The development realm gains the `astra-billing` client (needs `BILLING_CLIENT_SECRET` and a
  realm re-import).

## To confirm with Assurant

- The billing system's interface and its identifiers (account and entity codes), and the format they want.
- Commission terms per account; whether tax and fees are in or on top of premium, and the fee schedule.
- The daily peak and the window the export must meet.
- Whether bind waits for billing's payment confirmation.
- The card programme's premium basis and how its tax and commission are determined.
