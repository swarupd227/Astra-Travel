# ADR 0006: Rating engine (Increment 5)

Status: accepted, 24 November 2026.

## Scope

Increment 5a: rate manual library (E02-F01-S01), table lookups (E02-F02-*), the filed formula, peril
package, exclusion waivers and supplemental benefits (E02-F03-*), the Trip Cancellation rating variables
and derived inputs (E02-F04-*), the worksheet (E02-F07-S01), workbook parity (E02-F07-S02) and the rating
reference guardrails (E02-F09-*). Increment 5b: multi-benefit rating, CFAR and Trip Interruption
(E02-F05-*) and rate basis conversion (E02-F06-S01).

## Inputs we do not have yet

The Delaware Trip Cancellation manual (RETR-SP-VU-DE-0426), Assurant's rating workbook and the loss cost
multiplier. The specification quotes about a dozen of the manual's values (base loss cost $1.475 per $100,
the $4,001 trip cost band at 1.0000, age 45 at 0.7200 waived and 0.6000 not waived, December 1.2880,
20 days before departure at 0.7680, 120 days at 1.0910, the 451-day band at 1.2940, OTA - Cruise 1.6286,
optional package 1.3333, the 60-day penalty band at 1.28, the 1.1220 maximum combined waiver factor,
supplemental $0.002 per $100 and $0.020 flat, and the Death peril at 3.610% / 2.704% / 0.403%). These
are used as test oracles only, in a test manual that is labelled as partial and can never be published.

## Decisions

**Decimal arithmetic.** All rating arithmetic uses arbitrary-precision decimals (decimal.js), never
binary floating point, so results are exact and reproducible to the cent.

**A manual is data, validated by a schema.** A manual version holds its state, benefit, filing reference
(the filing register's rate-manual reference), effective dates, page references and:
- *tables*: banded by lower bound, keyed by exact value, or multi-key (for example age band by waiver
  status), each with optional *unused* and *unknown* factors and its page;
- *the formula*: base loss cost per exposure unit (for Trip Cancellation, per $100 of trip cost), the
  exposure table, the ordered list of multiplicative rating variables (each a table and the input it
  reads), the peril package, exclusion waivers with their maximum combined factor, supplemental benefits
  (per $100 below a threshold, a flat amount at or above it), and special rules (minimum trip cost);
- *conversion*: loss cost multiplier, minimum premium and the rounding steps.
A manual without a loss cost multiplier produces a **loss cost**, and every result says so.

**Lookups.** Banded tables match the highest band whose lower bound the value meets. If an account does
not collect a variable, the table's *unused* factor applies; if the value is collected but unknown, the
*unknown* factor applies; otherwise a missing value is an error. The worksheet records which, and why.

**Derived inputs** are calculated in one place: trip length (return minus departure plus one), days
before departure (departure minus purchase), the waiver time-sensitive period (initial deposit to
purchase), per-person trip cost (reservation total divided by travellers) and the primary destination
(most travel days).

**The worksheet** lists every input, derived value, table, band, factor, formula step, rounding and page,
in order. It carries the manual version and a hash of the inputs; re-rating the same inputs with the same
manual version always gives the same worksheet, and the API can reproduce a stored worksheet and compare.

**Publishing a manual** needs: a second person's approval, an approved filing in effect for its state
(the Increment 3 filing register), and every parity case passing to the cent. Parity cases come only from
the filed manual and Assurant's workbooks (imported from CSV); the prototype rater is never a source.
Rating in production uses only published manuals in effect on the rating date; older versions stay
available for re-rating. Estimated loadings may exist only in demonstration and sandbox environments,
labelled as illustrative, and can never be published.
