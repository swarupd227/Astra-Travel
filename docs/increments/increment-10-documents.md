# Increment 10: Documents

Design: [ADR 0011](../adr/0011-documents.md). Builds on the form library and variable maps (Increments 3 and 4),
plans (Increment 6), bind and the policy record (Increment 9) and the agent platform (Increments 1, 8).

Everything in the tests is **synthetic**: the schedule is a short invented form with bracketed ranges, the
plan values are made up, and the people and policies are fictional. No filed schedule or policy form has been
provided (the Virginia Surety schedule and the Delaware form are not here), so no real traveller document can
be produced yet; the assembly is built and tested against the filed format the specification describes.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E09-F01-S01 Assembled documents | No brackets or unselected options in the output | Met | Assembly fails, and says which wording, rather than guess: a variable with no value, an overlap, or any `[`, `]` or `<<…>>` left is a problem. Optional benefits the plan does not offer are removed with their line. `documents.test.ts`, `documents.int.test.ts` |
| | Values in the filed format (words and numbers) | Met | Periods and percentages as "ten (10)" and "one hundred percent (100%)", dollars with separators, limit basis as chosen, wording choices, reference lists (for example prohibited countries) |
| | The right limit basis | Met | The basis is a variable of the form; the plan's choice is inserted and checked against the filed options |
| E09-F01-S02 Purchase confirmation | Trip cost, benefits, limits, premium | Met | Built from the policy record with the insurer of each benefit; issued with the policy |
| | Issued with the policy and schedule | Met | Inside the bind transaction. `documents.int.test.ts` |
| E09-F01-S03 Change and cancellation documents | Show what changed | Met | `POST /v1/policies/:id/notices` for a policy event: a table of before and after, or the end of cover for a cancellation or expiry; one notice per event. The servicing transactions that create the events are Increment 11, which calls the same function |
| | Refund documents | Later | A refund is calculated by billing (Increment 12); the cancellation notice says so and states no amount |
| E09-F02-S01 Document Quality (AG-07) | Checks templates and a sample of issued documents against plan configuration and the filed form | Met with a scripted model | AG-07 reads the template or an issued document, the plan's values and the filed form, and submits findings that quote the text they are about; the platform checks each quote is in the document. `document-quality.int.test.ts`. **Not run against the real model**: there is no API key in this environment |
| | A template with a failed check cannot be released | Met | Release reruns the assembly, needs every check to pass, refuses while a finding is open and for good once a finding is accepted, and refuses the template's maker |
| | Findings reviewed by a person | Met | A person with `documents:release` marks each finding a defect or not an issue, with a note; the decision is recorded |
| E09-F03-S01 Delivery | Email or account delivery, status recorded | Met | Every document has an account delivery (available at once) and, when the purchaser gave an address, an email delivery the worker sends over SMTP with the PDF attached. Each attempt is recorded |
| | Failed deliveries create a task | Partly | A failed delivery raises `DocumentDeliveryFailed` and appears in the failed list with a "send again" action. The task queue itself is Increment 15 |
| | SMS link | Later | No SMS service exists; the channel is not offered |
| E04-F02-S03 Documents within 30 s | Documents available within 30 seconds of bind | Met | They are issued inside the bind itself; the test asserts the whole bind-and-issue is under 30 s |
| E21-F05-S01 Guide to Benefits | From master policy terms | Met | Built from the programme, its master policy and the benefits and limits of the chosen plan version |
| | Versioned with the programme | Met | Each guide is the programme's next version; earlier ones stay as issued. The link from a card programme to its plan is not modelled yet, so the plan is chosen when the guide is produced |

## What is built

- **Assembly** (`packages/documents`): number-to-words, nested bracket-span assembly, document builders, PDF
  output. The PDF is checked by reading its text back and comparing it with the assembled wording.
- **Templates**: a plan version's schedule or policy assembled from its filed form, its approved variable map
  and the plan's values (settings included). Immutable once released; one released template per plan version and
  kind. The reference list for a placeholder is the version in force on the day it is assembled and is named in
  the checks.
- **Issued documents**: immutable, with text, PDF in the file store, SHA-256, the template version that made them
  and their deliveries. A document that could not be produced is recorded as failed, with its reason, and the
  bind still succeeds; issuing again settles the record.
- **Delivery**: worker loop with retry and back-off (1, 5, 30 and 120 minutes, then failed). With no mail server
  configured, email deliveries fail at once with that reason.
- **Workbench**: Documents (templates, template page with checks, AG-07 panel and release; failed documents and
  deliveries; a document page with text, hash, deliveries and the PDF), a Documents card on each policy and on
  each plan version, and the findings review on the proposals page.

## To confirm with Assurant

- The wording and layout of the purchase confirmation and the notices (written here, to be replaced by theirs).
- Whether bind must refuse when the plan has no released template (production probably should; it is lenient
  here so the platform can be exercised before forms are loaded).
- The email retry schedule, the sender address and the mail service to use.
- How refunds appear on cancellation documents once billing exists.
