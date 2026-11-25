# Increment 14: Channels

Design: [ADR 0015](../adr/0015-channels.md). Builds on quote and bind (Increment 9), documents (Increment 10),
accounts and the sandbox (Increment 13) and the identity model of Increment 0.

Everything in the tests is **synthetic**: brand names and colours, origins, journey addresses, booking-file
contents and the test payments. **No payment provider has been chosen**, so no real purchase can be taken online:
the hosted journey completes only for a sandbox account, with a clearly labelled test payment, and says so for a live
one.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E04-F03-S01 Widget | Uses account branding and meets WCAG 2.2 AA | Met | `<astra-cover-offer>`, a custom element with its own shadow-root styles, labelled checkboxes, a live region and visible focus. The account's brand colours are refused unless text on the primary colour reaches 4.5:1 and the primary colour 3:1 on white. Axe is clean on the staff preview page that hosts it. `channels.int.test.ts`, `channels.spec.ts` |
| | Links to the full wording | Met | A button that opens the filed policy form (or schedule) of the quote's plan, fetched with the widget's token |
| | (Security) a browser-held token cannot create or bind | Met | The widget token reads one quote and changes its optional benefits (new `quotes:reselect`); the API refuses it for any other quote, quote creation, bind and policies. CORS answers only the origins the account lists |
| E04-F03-S02 Booking files | Files are validated; a result file lists accepted and rejected with reasons | Met | CSV, one row per traveller, rows sharing `booking_ref` are one booking; every booking goes through the real quote and bind with a per-row idempotency key, so a file cannot be loaded twice and a retry cannot double-bind. At most 500 bookings per file |
| E04-F03-S03 Staff quote and issue | Same rules and rating as the API | Met | Staff use the same endpoints; the quote screen has an "Issue the policy" form (payment reference and amount, purchaser, acknowledgement) |
| | The policy records the staff user who issued it | Met | The bind event's actor and name |
| E04-F03-S04 Hosted journey | Configured from the account without code | Met | Branding, slug, plans and headline in the account's channel settings; served at `/j/<slug>` without sign-in |
| | Partner branding and the plan's required disclosures | Met | Brand colours and logo; the state disclosure is shown and its acknowledgement is required before purchase |
| | WCAG 2.2 AA | Met on the screens built | Axe is clean on the journey's start, price, payment and confirmation pages |
| | (Payment) | Not available | No provider: a live account's journey stops at "online payment is not set up", and the API refuses a journey bind for a non-sandbox account |

## What is built

- **Channel tokens** (`@astra/contracts/channel-token`): HMAC-signed, scope-limited, account-bound, for one quote when held by a browser;
  the API accepts them beside identity-provider tokens and refuses them without `CHANNEL_SIGNING_SECRET`.
- **Database**: `channels.settings` (branding, widget, journey, unique journey address) and `channels.booking_files`,
  plus two small functions the public journey and the CORS check use to read settings without an account scope.
- **API**: channel settings, public journey configuration, widget sessions, offer, wording, the widget script,
  and booking files with their result file.
- **Workbench**: account Sales channels settings, widget preview on the quote page, an "Issue the policy" form,
  Booking files, and the public hosted journey (start, options, payment, confirmation).

## To confirm with Assurant

- The payment provider and how its confirmation reaches bind.
- Where the widget script is hosted (a content delivery network and versioning) and the host pages' content-security policies.
- The booking-file layout accounts will really send (the columns here are ours) and whether files above 500 bookings need an asynchronous service.
- Branding beyond a name, logo and two colours (fonts, a custom domain for the hosted journey).
- Whether the hosted journey should offer account or bank retail plans differently from other plans.
