# ADR 0015: Sales channels (Increment 14)

Status: accepted, 26 November 2026.

## Scope

E04-F03-S01 (embeddable widget), S02 (booking files), S03 (staff quote and issue) and S04 (hosted purchase
journey). Every channel sells through the same quote and bind rules as the API: nothing here prices, screens or
binds in its own way.

## Decisions

**One set of rules; channels differ only in who holds the credentials.** The widget, the hosted journey and the
booking files all end in the existing quote, selection and bind operations. Staff use the same API as partners; the
policy records the staff user who bound it (the event's actor), as it already does.

**Channel tokens carry exactly what a channel may do.** The API accepts, besides identity-provider tokens, a short
signed token (HMAC, secret `CHANNEL_SIGNING_SECRET`) with the account, a scope, a list of permissions and,
for a browser, one quote. A **widget** token lives in the traveller's browser, so it can read one quote and
change its optional benefits (the new `quotes:reselect` permission) and nothing else: it cannot create a quote or
bind. It is refused for any other quote. The partner's server obtains it with `POST /v1/quotes/:id/widget-sessions`.
A **journey** token is minted only by the hosted journey's server, after payment, and can create, select and bind.
Without the secret configured, channel tokens are refused.

**The widget is a custom element with its own styles.** `<astra-cover-offer>` is served by the API
(`/widget/v1/astra-widget.js`), draws in a shadow root so the host page cannot break it, takes the account's
branding from the account's channel settings, shows each benefit with its limit, the optional ones as labelled
checkboxes that re-rate through the API, the premium, and a link to the filed wording. It announces changes to
screen readers. Brand colours are checked when saved: text on the primary colour must reach WCAG AA contrast (4.5:1),
so a brand cannot make the widget fail the standard. The widget never binds; the host page's own server binds with
the partner's credentials once the traveller has paid. CORS for the widget allows only the origins the account
lists.

**Booking files are validated, then processed row by row with the real API.** A CSV of bookings (several rows with
the same booking reference are the travellers of one booking) is uploaded by the account, validated as a whole, and
each booking is quoted and bound through the same routes with a per-row idempotency key derived from the file's
hash, so loading the same file twice is refused and a retry never double-binds. The result file lists each booking
as accepted (with the policy number and premium) or rejected (with every reason). A file is limited to 500 bookings;
larger volumes go in several files. Payment is taken from the file's payment reference and amount, which the
account vouches for exactly as an API caller does.

**The hosted journey is configured, not coded, and does not take money.** An account's channel settings name its
journey (slug, plans, states, headline) and branding; `/j/<slug>` serves it without sign-in. The traveller enters
the trip and travellers, sees the options and price, acknowledges the state disclosure and confirms they are able to
travel. **Payment is a provider interface with no live implementation**: no payment provider has been chosen, so a
live account's journey stops at "payment is not set up". For a sandbox account a clearly labelled test payment
completes the purchase, so the whole journey can be exercised. A real provider plugs in without changing the
journey.

**Staff issue from the quote screen.** A service representative or account manager binds a quote on the traveller's
behalf by entering the payment system's reference and amount, the purchaser and the traveller's acknowledgement of
the disclosure; the API checks all of it as for any caller.

## Not decided here

The payment provider and its confirmation, the widget's hosting and versioning on a content delivery network, the
exact file layout accounts will send (the columns here are ours), whether very large files need an asynchronous
service, and any further branding (fonts, logos beyond a URL).
