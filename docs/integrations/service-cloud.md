# Salesforce Service Cloud: sample calls

For Assurant's Salesforce team (E14-F02). **No Service Cloud org is connected yet**: these are the calls the
platform answers, with synthetic values. The full contract is the OpenAPI document at `/docs` on the API.

## Signing in

Each representative acts with their own platform identity, so their role and account scope decide what they can see
and do. Salesforce obtains an access token for the representative from the platform's identity provider (OAuth 2.0
authorisation code with PKCE, or the token-exchange arrangement agreed with Assurant's identity team) and sends it as
`Authorization: Bearer <token>`. A shared integration user is not recommended: every action would be recorded
against it.

On every call made for a case, also send both of:

| Header | Meaning |
|---|---|
| `x-service-cloud-user` | The Salesforce user id |
| `x-service-cloud-case` | The case number or id |

Up to 100 characters each: letters, digits and `. _ @ : / -`. One without the other is refused.

## 1. Find a customer's cover

```http
POST /v1/service/customer-view
Authorization: Bearer <representative's token>
x-service-cloud-user: 005XX000001Sv6AAE
x-service-cloud-case: CASE-00012345
content-type: application/json

{ "lastName": "Sample", "dateOfBirth": "1980-05-05" }
```

Send exactly one of `{ "policyNumber" }`, `{ "lastName", "dateOfBirth" }` or `{ "cardholderRef" }`. The answer holds
`policies` (each with the current record, benefits with limits and dates, history and documents), `certificates` for
card-linked cover, and `truncated` when more than ten policies matched.

## 2. Quote a change

```http
POST /v1/policies/{policyId}/servicing/preview

{ "type": "change_dates", "reason": "Flight moved", "departureDate": "2027-03-02", "returnDate": "2027-03-12" }
```

The answer says whether it is allowed, what changes, the premium before and after, and `confirmAmount`.

## 3. Confirm the change, or cancel

```http
POST /v1/policies/{policyId}/servicing
idempotency-key: <a new value for each action; repeat it to retry safely>

{ "request": { "type": "cancel", "reason": "Customer request", "noLoss": true }, "confirmAmount": "-84.00" }
```

Show the customer the amount from the preview first. If the price has moved, the platform refuses and the new preview
is shown.

## 4. Send documents again

```http
POST /v1/policies/{policyId}/documents/resend

{ "reason": "Customer did not receive the email" }
```

They go to the address on the policy. To change it, make a `correct` change first.

## Apex example (callout)

```apex
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:Astra_Travel/v1/service/customer-view'); // Named Credential, per-user principal
req.setMethod('POST');
req.setHeader('content-type', 'application/json');
req.setHeader('x-service-cloud-user', UserInfo.getUserId());
req.setHeader('x-service-cloud-case', caseRecord.CaseNumber);
req.setBody(JSON.serialize(new Map<String, Object>{ 'policyNumber' => policyNumber }));
HttpResponse res = new Http().send(req);
```

## Receiving policy events

Subscribe a webhook (workbench: Partners → Webhooks, or `POST /v1/webhook-subscriptions`) to `PolicyBound`,
`PolicyChanged` and `PolicyCancelled`; changes and cancellations carry the charge and refund. Each delivery is signed
(see the webhook signature headers in the API documentation), retried with back-off, and after the last attempt
appears in the platform's work queue as "Event not delivered", from where it can be replayed.
