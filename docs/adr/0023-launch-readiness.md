# ADR 0023: Launch readiness and go-live sign-off

Status: accepted (Increment 18). Stories: E16-F01-S01, E16-F02-S01.

## Decisions

1. **Readiness is computed, not ticked.** For each state: a published plan in effect with its published eligibility
   rules; for every rated benefit a published, non-illustrative manual whose latest parity run matches every case and
   an approved filing for it; released document templates and approved filings for the forms.
2. **A signature is for what was read.** The report has a hash over its states and checks. Signing quotes that hash and
   is refused if the report has changed; signatures do not carry to a changed report. The date is not part of the hash.
3. **Four areas, four people, own role**: product manager, rating analyst (actuarial), compliance officer and finance
   analyst. A state that is not ready cannot be signed. Signatures and withdrawals are immutable records and audited.
4. **Nothing is switched by the approval.** It records that the people agreed; opening sales is done by publishing and
   taking accounts live, which have their own controls.

## Not covered

- Plan tests are not re-run by the report: a plan cannot be published unless they pass.
- Account-specific readiness (onboarding has its own checklist), billing and licence readiness.
- Whether actuarial sign-off should come from a role other than rating analyst: Assurant to confirm.
