# ADR 0005: Benefit catalogue (Increment 4)

Status: accepted, 22 November 2026.

## Scope

E01-F02-S01 (benefits with sub-limits, per-day limits and deductibles), E01-F02-S02 (covered reasons with
categories, coverage levels and peril numbers) and E01-F02-S03 (optional upgrades, including upgrades that
replace base limits). Choosing benefits, values and packaging for a plan is the plan builder (Increment 6);
rating them is the rating engine (Increment 5).

## Inputs we do not have yet

The VSC schedule (trvl_sch_cw, edition 2026-04) and the rate manuals' peril tables have not been provided.
The specification names the schedule's benefit groups, benefits, sub-limits and upgrades (section 5.2), but
not their amounts, ranges, covered reasons or peril numbers. So the catalogue starts empty: nothing is
pre-loaded from the specification's lists, because a catalogue that looks complete but is not traceable to
the filed schedule would be worse than an empty one. Tests use synthetic entries, labelled as such.

## Decisions

**A catalogue belongs to a schedule edition, with its policy form.** Amounts are in the schedule;
covered reasons are worded in the policy form. A catalogue is built from the schedule edition and,
optionally, the policy form edition it goes with, using their approved variable maps (Increment 3). Every
amount, deductible, per-day limit, limit basis and optional item refers to a variable by document and key
(`schedule:tc_max` or `policy:cfar_percentage`), so filed ranges live in one place and the catalogue cannot
contradict the forms. A reference is checked when it is saved: the variable must exist in that document's
approved map and be of a suitable type (an amount is a numeric range, a basis a limit basis, an optional
item an optional benefit).

**Versioned, approved by a second person, immutable once approved.** As with variable maps: one draft at a
time per edition, a new draft starts as a copy of the approved catalogue, whoever created or edited a draft
cannot approve it, and approval supersedes the previous version. A catalogue built on an older map version
must be rebuilt when the map changes (the approval checks every reference against the map in force).

**Structure.**
- *Benefits* have a code, name, group (the schedule's groups: pre-departure, post-departure trip, baggage,
  rental and accommodation, activities and events, medical and evacuation, accident), the optional-benefit
  variable that switches them on (if the form makes them optional), a maximum benefit amount, and optional
  per-day maximum and deductible, each with its limit basis (per person, per trip, per reservation or per
  policy: a fixed basis, or a limit-basis variable when the form lets the plan choose).
- *Sub-limits* belong to a benefit, with their own amount and basis, and say whether they are included in
  the parent maximum or paid in addition, as the schedule states.
- *Event amounts* (Travel Inconvenience) are fixed amounts per named event.
- *Covered reasons* belong to Trip Cancellation, Trip Interruption or both, are grouped in the form's
  categories (for example Medical and Health, Employment and Service), list the coverage levels they apply
  to (self, family member, travelling companion, business partner, host at destination), and carry the
  rating manual's peril number. Reasons from an optional upgrade set name that upgrade.
- *Upgrades* are covered-reason sets, benefit packages (for example the Pet Package) or sports upgrades,
  each with the variable that offers it. An upgrade may *replace* limits: for each replaced amount it names
  the target (a benefit's maximum, per-day limit or deductible, or a sub-limit) and the replacement amount
  variable. `effectiveLimits(catalogue, values, selectedUpgrades)` applies them, so the plan builder,
  documents and rating all see the same limits.

**Peril numbers before the manuals arrive.** A covered reason may be saved without a peril number, and the
catalogue shows how many are missing; it cannot be approved while any reason lacks one, because rating
(E02) needs every peril. This keeps the gap visible instead of filled with guesses.

**Stored as a validated document.** A catalogue version is one JSON document validated by a schema, with
item-level API operations that edit it inside a transaction. Catalogues are small (tens of benefits,
hundreds of reasons), are always read whole, and are approved whole; a document keeps version comparison
and immutability simple.
