# ADR 0020: Sanctions screening at change and refund, and delivery receipts

Status: accepted (Increment 16d). Stories: E14-F03-S02, E14-F03-S03.

## Context

Screening ran inside the eligibility decision (quote, bind and re-rated changes) against an OFAC list loaded and
approved in the platform. Two gaps: a name correction that did not re-rate was not screened, and a refund was not
screened at all. Delivery recorded only what the mail server accepted. No screening vendor, SMS or print provider has
been named.

## Decisions

1. **Every change screens everyone who would be on the policy**, including the purchaser. A possible match raises a
   sanctions hold (stage `change`) and the change is refused until a person decides it. The hold is committed even
   though the change is refused. With screening switched on and no approved list, changes are held, as bind is.
2. **A decision stands for exactly what was matched.** A hold's case reference names the policy and a fingerprint of
   which names matched which entries, so clearing it does not clear a different name or a new match.
3. **A refund is screened when money goes back.** A match does not stop the cancellation: the traveller is no longer
   covered and no longer charged. The refund's premium record is **held**, so billing never receives it, until the
   hold (stage `refund`) is cleared, which releases it at once; a confirmed match marks it "Do not pay".
4. **Delivery receipts** come from the provider (`delivery_provider` system role) to `POST /v1/delivery-receipts`,
   matched by the `X-Astra-Delivery-Id` header each email now carries. A bounce marks the delivery failed, which puts
   it in the work queue and allows retry. Late or irrelevant reports are listed and ignored.

## Not built

- An external screening vendor: the screening function is one module; a vendor would replace its matching.
- SMS and print: no provider, and no phone number is collected. Nothing pretends to send them.
- The email provider's own receipt format and signature: an adapter will translate it to the receipts endpoint.
- A `delivery_provider` client in the local identity provider (tests issue the token).
