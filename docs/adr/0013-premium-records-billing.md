# ADR 0013: Premium records and the billing interface (Increment 12)

Status: accepted, 25 November 2026.

## Scope

E08-F01 (premium records, billing bases, entity allocation), E08-F02 (commission with clawback, premium tax and
fees), E08-F03 (sending records to Assurant's billing system and receiving confirmations), E08-F04 (high-volume
export with control totals, programme-level premium for card cover) and E14-F03-S01. Billing and payment
collection stay in Assurant's system; this platform creates the records and receives the answers.

Not here: the billing system's real interface. Its form (API, files or MuleSoft) is "to be agreed" in the
specification and nothing was provided, so the platform offers a **file drop** and a **signed HTTP push** with
the same batch format and a confirmation endpoint, to be matched to whatever is agreed. Bind waiting for payment
confirmation (E08-F03-S02) stays as it is: bind needs the payment system's reference and an amount equal to the
premium, so payment is confirmed by whoever calls bind. The refund status is shown on the policy.

## Decisions

**One premium record per policy transaction, immutable.** Bind, each change and each cancellation writes a
record inside the same transaction as its policy event, so a transaction without a record cannot exist. The
record holds the signed premium (a charge is positive, a refund negative), the premium per benefit and per
traveller, the allocation by underwriting entity, the commission, the premium tax, the account's billing basis
and its calculation as the quote stored them, and links to the policy event and the rating worksheets. Records are
append-only. A record that cannot be completed is **held** with its reasons rather than guessed.

**Amounts are whole cents and always add up.** A transaction's amount is spread over benefits, travellers and
entities by largest remainder in proportion to the premium of each (for a change, to the change in each), so each
view sums to the record's total exactly. Entities follow each benefit's underwriting arrangement in the plan:
VSC, ABIC, and the VSC CLIP arrangement, which is VSC's entity with its arrangement shown. A benefit without an
arrangement is held as unassigned.

**Premium tax and fees come from the reference data and nothing else.** The rate for the state and entity in force
on the date (dataset `premium_tax_rates`) is applied to each entity's amount. With no rate loaded the record is
held and says which state and entity lack one. Whether tax is inside the premium or on top is not stated in the
specification; the record reports the tax in the premium, as the dataset's "tax and fee rate", and does not add it.

**Commission follows rules configured per account, none assumed.** A rule is flat (a percent), tiered (marginal
percents by the account's premium so far in the month) or volume (a percent chosen by the number of policies the
account has sold in the month); an account can also be set to pay none. Rules have an effective date and need a
second person's approval. An account with no approved rule holds its records. **Clawback**: a refund takes back
the commission at the effective rate of the original bind record, so retained premium keeps its commission.

**Records go to billing in batches that carry control totals.** A batch takes each ready record once (a record is
in at most one batch, enforced by the database), writes it to a newline-delimited file in the file store with a
header and a trailer holding the record count and the premium, commission, tax and refund totals, and a hash.
The worker sends the batch (file drop or signed HTTP push). Billing answers on `POST /v1/billing/confirmations`
with what it received: counts and totals are compared with the batch's and a difference marks the batch
`mismatch` and raises an alert; otherwise the records are confirmed or rejected one by one with billing's
reference. An unconfirmed batch is sent again, with the same batch ID so billing can ignore a repeat, up to a
limit, then marked `unconfirmed` and alerted; staff can retry it. Exports are streamed from the database, so volume
is bounded by throughput and not by memory; a measured rate is recorded in the tests. The specification's
"ten times the measured daily peak" cannot be shown: no daily peak has been measured or provided.

**Card programme premium is a record of its own.** A programme's rule gives a rate per eligible account per month
(the basis the specification names); a month's record counts the accounts eligible on its last day from the
eligibility ledger. It goes to billing in the same batches. Tax and commission are not calculated on it: they
need the issuer's state split and commission terms, which are not defined.

## Not decided here

The billing interface itself, who pays tax on top of premium, how fees differ from tax, commission terms, the
programme premium's rate, the volume to plan for, and whether bind should wait for billing's payment confirmation.
