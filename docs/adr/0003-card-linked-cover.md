# ADR 0003: Card-linked cover and the eligibility ledger (Increment 2, epic E21)

Status: accepted, 20 November 2026.

## Scope

E21-F01 (programmes, master policies, certificates), E21-F02 (eligibility feeds, as-of answers, scale),
E21-F03 (payment condition) and the file-transfer integration pattern deferred from E14-F01-S01. The
Eligibility Feed agent (E21-F04) comes with the integration increment, the Guide to Benefits (E21-F05)
with documents, and programme migration (E21-F06) with launch readiness.

## Decisions

**Programmes belong to the issuer's account.** A card programme is owned by a card-issuer or bank account
(a tenant), so row-level security keeps each issuer's programmes, feeds and cardholders apart. It links to a
master policy, its states, effective dates, a payment condition and an eligibility rule. The plan link is
recorded when the plan builder ships (Increment 6).

**Cardholders are identified only by the issuer's account reference.** Feeds carry an opaque account
reference (a token), a card product code and eligibility dates; nothing else about the cardholder. A record
whose reference looks like a payment card number (13 to 19 digits, Luhn-valid) is rejected and the number
is never stored.

**The eligibility ledger keeps every version.** Each account has a chain of periods, each recording the
feed that established it and the feed that ended it. Feeds never overwrite: a change ends the current
period and starts a new one. "Was this cardholder eligible on date D?" is answered from the period that
covers D, together with the feed sequence that established it.

**Certificates.** The first time an account becomes eligible in a programme it receives a certificate
number (`<programme code>-<number>`), kept for life. The certificate is the coverage record for that
cardholder under the master policy.

**Feeds are processed exactly once, in order, and only if they pass control checks.**
- A file is stored, hashed (SHA-256) and accepted once per checksum.
- Header and trailer control totals (record counts by action) must match the detail records.
- Live feeds apply strictly in sequence; a later feed waits for its predecessor. The first live feed is a
  full feed.
- A feed that fails control checks, or rejects more records than the programme allows, is **held**: nothing
  is applied and the previous version stays in force. Later feeds wait. A person rejects the held feed and
  the issuer resends that sequence.
- Records are staged and applied with set-based SQL in one transaction, which keeps large feeds within the
  daily window. Staging (`card.feed_records`) and the apply plan (`card.feed_plan`) are unlogged tables:
  they can be rebuilt from the stored file, so they skip the write-ahead log. The applying session raises
  its own statement and transaction time limits, and writes its audit record as the last statement before
  commit, so the audit sealer (which assumes audit rows commit within seconds) is unaffected.
- A held feed keeps its sequence. A file that reuses an applied, waiting or held sequence, or names another
  programme, is rejected instead.
- A **test** feed is validated and its effect calculated without applying anything. A programme can go live
  only after a test feed has passed (E21-F01-S01).

**Payment condition.** Configured per programme: the trip must be paid in full, in part (with a minimum
percentage), or with no condition, using the eligible card or account. Checked from amounts the
caller supplies; card numbers are never received.

**Cover verification.** One endpoint answers for certificates now and for retail policies from
Increment 9: eligibility on the purchase date and on the loss date, each with the supporting feed version,
the certificate number, the master policy and whether the payment condition is met. Callers are the claims
application (a machine client with the `cover:verify` permission) and staff.

**File transfer.** Locally, feeds are uploaded through the API (streamed to disk, hashed, then processed by
the worker). In Azure the same processor is triggered by files arriving in an SFTP-enabled Blob Storage
container. The feed format is documented in `docs/integration/eligibility-feed-v1.md`.

**Scale.** The ledger is designed for tens of millions of accounts. A load test script measures full and
change feeds at a chosen volume; results are recorded with each run.
