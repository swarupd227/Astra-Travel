# ADR 0019: Salesforce Service Cloud

Status: accepted (Increment 16c). Stories: E14-F02-S01, E14-F02-S02, E14-F02-S03.

## Decisions

1. **The representative signs in as themselves.** The platform authorises the person, so access follows their role
   and account scope with no second permission model. Service Cloud's user and case are recorded beside that, from
   two headers (both or neither), in the audit trail and on the policy event.
2. **One lookup by something the customer can give**: policy number, last name with date of birth, or cardholder
   reference. It is a POST so no personal detail is in an address, returns at most ten policies, and its audit entry
   records the kind of detail used and what was returned, not the detail.
3. **Servicing uses the existing preview and confirm**, so Service Cloud cannot make a change the platform would
   refuse or at a price the customer was not shown. A preview made for a case is audited.
4. **Resend queues the deliveries on record** to the same address; changing the address is a correction to the
   policy, with its own record and notice.
5. **Events go through the platform's webhooks** (signed, retried, dead-lettered, replayable). A delivery that has
   run out of retries now appears in the work queue ("Event not delivered", high priority, 4-hour placeholder timer):
   that is the alert.

## Not decided

- How Salesforce will obtain a representative's token (Assurant's identity team).
- Whether Assurant wants Platform Events or another Salesforce inbound format instead of webhooks.
- An email lookup: the purchaser's address is held in the policy record and is not indexed.
- Paging the queue alert to people outside the workbench.
