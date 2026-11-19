# Integration patterns (E14-F01-S01)

Every Astra Travel integration (accounts, card issuers, Assurant billing and claims, Salesforce Service
Cloud, sanctions, messaging, data platform) uses one of the patterns below, so each is built, secured and
monitored the same way.

## 1. Inbound REST APIs

| Concern | Standard |
|---|---|
| Versioning | Major version in the path (`/v1/...`). Additive changes only within a version. Events carry their own `version`. |
| Authentication | OAuth 2.0 bearer tokens from the identity provider. Partners use client credentials and are bound to one account. |
| Idempotency | Every create or bind takes an `Idempotency-Key` header (8 to 200 characters). Same key and body: original response replayed with `idempotent-replayed: true`. Same key, different body: `422 idempotency_key_reused`. Keys are kept 24 hours. |
| Errors | RFC 9457 problem details with a stable `code`, field-level `errors[]` (`code`, `message`, `field`) and `correlationId`. |
| Correlation | Send `x-correlation-id`; it is returned, logged, traced, written to the audit trail and carried on every event. |
| Limits | Rate limit per principal (default 600 per minute) and a 1 MB body limit. |
| Documentation | OpenAPI 3.1 at `/docs`, generated from the same schemas that validate requests. |

## 2. Outbound webhooks (events to partners and Service Cloud)

- Subscriptions per account and event type, created through the API. HTTPS only, public addresses only;
  the target is checked at registration and again at connection time (DNS rebinding protection).
- Body: the standard event envelope. Headers: `Astra-Event-Id`, `Astra-Event-Type`,
  `Astra-Delivery-Attempt`, `x-correlation-id` and `Astra-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`.
  Receivers reject signatures older than 5 minutes.
- Any non-2xx answer or a timeout (10 s) is a failure. Retries back off from 10 seconds to 1 hour for 12
  attempts (about 9 hours), then the delivery is dead-lettered and alerted. Replay is an audited action.
- A circuit breaker per subscription stops hammering a failing endpoint. Delivery can be switched off per
  account with the `integration.webhooks-delivery` flag; deliveries then wait rather than fail.

## 3. Outbound synchronous calls (sanctions, billing APIs, spreadsheet bridge)

`outboundFetch` in `@astra/platform`: per-attempt timeout, retries only for idempotent requests on 408, 425,
429 and 5xx with exponential back-off and jitter, `Retry-After` honoured, circuit breaker per endpoint, and
metrics `astra.integration.calls` / `astra.integration.duration` by integration and outcome.

## 4. File transfer (eligibility feeds, batch bind, billing exports)

Delivered with the first file-based feature (card eligibility feeds, Increment 2) using the same rules:
files land in a secure drop zone, are processed exactly once per checksum, are validated against control
totals before anything is applied, produce a result file, and failures are held and alerted.

## 5. MuleSoft

Assurant mentioned MuleSoft. The platform's REST APIs and webhooks are consumable from MuleSoft without
change. Whether MuleSoft is Assurant's standard integration layer, and for which systems, must be confirmed
with Assurant before any MuleSoft-specific work (specification section 21, question 14).
