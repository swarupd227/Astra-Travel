# ADR 0014: Account onboarding and configuration (Increment 13)

Status: accepted, 25 November 2026.

## Scope

E07-F01 (guided onboarding with a go-live gate; the Account Onboarding agent AG-05), E07-F02 (business segment
with underwriter approval and an effective date; which rating variables the account collects), E07-F03
(licences and registrations by state with expiry alerts and a sales block; sandbox credentials and
documentation). Not here: partner-facing screens (accounts use the API), and issuing production credentials,
which is Assurant IT's process in their identity provider.

## Decisions

**An account's configuration is a profile, and the checklist is computed from it, not ticked.** The profile holds
the contract reference and signing date, the plans and states the account sells, the integration method, the
billing basis (the platform's existing basis schema) and the settlement terms. Each onboarding item is judged
from what is actually configured: the contract (reference and date), each selling state having an unexpired
licence or registration, an approved segment, every plan existing and published for its state, an integration
method, a rate basis, settlement terms, the collected-variables decision made, and **tested**, which is true only
when the account's sandbox has made a quote and bound a policy through the API. **Go live** is refused until every
item is complete, and says which are not; it sets the account active and switches licence enforcement on.

**Segments come from the filed list and change only with an underwriter.** A change is a request naming a segment
in the `business_segments` reference data, with an effective date; an underwriter other than the requester
approves or declines it. The segment in force on a date is the approved one with the latest effective date at or
before it. Quotes use the account's segment in force on the purchase date, and a quote that names a different
segment is refused, so the segment factor is never taken from the caller.

**Collected variables are explicit and used by the engine.** For each rating input the account either collects it
or does not; the not-collected list is set by a rating analyst, recorded, and passed to the rating engine, whose
worksheet already prints the filed "not collected" factor it applied. Until the decision is made the account is
treated as collecting everything (the engine's default) and the checklist item stays open.

**Licences gate sales, from go-live.** Retailer registrations and producer licences are recorded per account and
state with their number and dates. An account that has gone live sells in a state only while it holds an unexpired,
unrevoked licence there; quote and bind are refused otherwise, saying which state and why. Accounts that predate
this (or have not gone live) are not blocked, so existing integrations are not broken before they are onboarded.
A daily worker pass raises `LicenceExpiring` at 60 and 30 days before expiry (once each), visible on the
Licences screen; email or webhook delivery follows the existing event subscriptions.

**The Account Onboarding agent proposes and a person decides.** AG-05 reads the account's contract and term sheet
(uploaded to the account as text or PDF) and proposes profile fields. Every field carries its source: the
document and an excerpt, which the platform checks is really in the document. A person approves, corrects or
rejects each field; the accepted ones are applied through the ordinary profile API and recorded. AG-05 is L2: it
cannot save anything itself.

**The sandbox is a separate account, and sandbox transactions are not billed.** Signing creates a sandbox twin
(`<code>-SBX`) that can quote, bind and service against the published plans with synthetic travellers; its policies
create no premium records and send no email, and it never counts toward live licence checks. Credentials are
issued to the twin through an issuer interface: the Keycloak implementation creates a confidential client
carrying the twin's account claim and returns the secret once (it is never stored; only the client ID and when it
was issued and revoked). Where there is no identity-provider admin access the issue is refused, saying so; Azure
(Entra ID) issuing is for Assurant IT to confirm. The documentation page shows examples for quote, bind, change
and cancel using the twin's own values.

## Not decided here

How production credentials are issued in Entra ID, whether licences are required for card issuers, the contract
wording AG-05 reads, which settlement terms are structured, and who is told about expiring licences.
