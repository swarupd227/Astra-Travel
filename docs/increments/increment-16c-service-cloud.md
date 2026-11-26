# Increment 16c: Salesforce Service Cloud

Design: [ADR 0019](../adr/0019-service-cloud.md). Sample calls: [service-cloud.md](../integrations/service-cloud.md).
Everything in the tests is **synthetic**. **No Salesforce org is connected.**

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E14-F02-S01 View | Cover, documents and history for a customer | Met | `POST /v1/service/customer-view`; `service-cloud.int.test.ts` |
| | Access follows the representative's role | Met | The representative's own token; account scope and permissions |
| | Sample call documented | Met | Not yet tried from Salesforce |
| E14-F02-S02 Actions | Quote a change, confirm, cancel, resend documents | Met | Existing preview and servicing, new resend |
| | Each action records the Service Cloud user and case | Met | Headers recorded in audit and policy history. They are the caller's statement; the platform cannot verify them |
| E14-F02-S03 Events | Bind, change, cancellation and refund events published | Met | Webhooks; refunds are carried on change and cancellation events |
| | Failed deliveries retried and alerted | Met in the platform | Retries and dead letters from Increment 0; dead deliveries now in the work queue |

## To confirm with Assurant

- Token arrangement for representatives, and the inbound format Salesforce will accept.
- Who should be told, and how, when events cannot be delivered.
