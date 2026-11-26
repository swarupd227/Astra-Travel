# Increment 16d: Screening and delivery integrations

Design: [ADR 0020](../adr/0020-screening-and-delivery-integration.md). Everything in the tests is **synthetic**,
including the sanctions entry.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E14-F03-S02 Screening | At quote, bind, change and refund | Met against the loaded list | Quote and bind from Increment 7; change and refund added; `screening-delivery.int.test.ts`. **No screening vendor** is connected; the list is loaded as a file |
| E14-F03-S03 Email, SMS and print | Delivery status is returned | Partly: email only | Receipts endpoint, message header, bounce to the queue. **SMS and print are not built**; no email provider is connected to send receipts |

## To confirm with Assurant

- The screening vendor, if any, and whether a refund hold should also stop the cancellation.
- The email, SMS and print providers, their receipt formats, and whether phone numbers should be collected.
