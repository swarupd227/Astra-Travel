# Eligibility feed format, version 1

Card issuers and banks send eligible cardholder accounts for a card programme as a UTF-8 text file with
pipe-separated fields, one record per line. Every file has one header, any number of detail records and
one trailer. Lines end with LF or CRLF.

## Header

```
H|ASTRA-ELIG|1|<programme code>|<sequence>|<FULL or CHANGE>|<as-of date>
```

| Field | Rule |
|---|---|
| Programme code | The code Assurant gave the programme, for example `SWANBANK-TRAVEL`. |
| Sequence | Positive integer, one higher than the previous feed for the programme. The first feed is 1 and must be `FULL`. |
| Kind | `FULL`: the complete list of eligible accounts. `CHANGE`: only additions, updates and removals. |
| As-of date | `YYYY-MM-DD`. Changes take effect from this date unless a record gives its own dates. |

## Detail records

```
D|<account reference>|<product code>|<action>|<eligible from>|<eligible to>
```

| Field | Rule |
|---|---|
| Account reference | The issuer's token or account reference, 4 to 64 characters `A-Z a-z 0-9 - _ .`. **Never a card number**: a reference that looks like one is rejected and not stored. |
| Product code | The issuer's card product, 1 to 32 characters. |
| Action | `A` add, `U` update, `D` remove. Full feeds use `A` only. |
| Eligible from | `YYYY-MM-DD`, the first eligible day. |
| Eligible to | `YYYY-MM-DD`, the last eligible day (inclusive), or empty for open-ended. For `D`, the last eligible day; if empty, eligibility ends the day before the as-of date. |

Changes to an account already on file take effect from the as-of date; earlier history is kept as it was.
A new account is eligible from its eligible-from date, which may be before the as-of date.

## Trailer

```
T|<detail count>|<adds>|<updates>|<removes>
```

The counts must equal the detail records in the file. A file whose header or trailer is missing or wrong,
whose counts do not match, or whose share of rejected records exceeds the programme's limit is **held**:
nothing in it is applied, and the previous eligibility stays in force.

## Example

```
H|ASTRA-ELIG|1|SWANBANK-TRAVEL|1|FULL|2026-12-01
D|tok_8f2a91c0|PLAT|A|2026-01-15|
D|tok_77b0e4d2|GOLD|A|2025-06-01|2027-05-31
T|2|2|0|0
```

## Delivery

Upload through `POST /v1/card-programmes/{id}/feeds?mode=live|test` with the file as the request body
(`application/octet-stream`), or, in Azure, by SFTP to the programme's drop folder. Each file is accepted
once (by SHA-256); a repeated upload returns the original feed.
