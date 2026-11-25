# ADR 0011: Policy documents (Increment 10)

Status: accepted, 25 November 2026.

## Scope

E09-F01 (assembly of the schedule and policy, purchase confirmation, change documents), E09-F02 (Document
Quality agent AG-07, release gate), E09-F03 (delivery and its status), E04-F02-S03 (documents within 30
seconds of bind) and E21-F05-S01 (Guide to Benefits). Not in this increment: SMS links (the channel is
specified, no SMS service exists), documents triggered by servicing (Increment 11 calls the change-notice
builder built here), and the card programme's own plan link, so the guide is built from a plan chosen when it
is produced.

## Decisions

**Assembly uses the filed wording and the approved variable map; nothing else.** A filed form's text has
bracketed options and values; the form's approved variable map says where each is. Assembly walks the spans,
nested ones included, and replaces each with the plan's value in the filed format: dollar amounts with
thousands separators, periods as words and figures ("ten (10)"), percentages the same way, the chosen limit
basis, the chosen wording alternatives, a reference list for placeholders such as prohibited countries. An
optional benefit span is kept (without its brackets and "[Optional]" marker) when the plan offers it and
removed whole when it does not. Assembly **fails** rather than guess: a kept variable with no plan value, or
any square bracket or `<<…>>` left in the result, is an error that names the wording.

**A template is a plan version's schedule or policy, pinned to its sources.** It records the plan version, the
filed edition and the approved variable map version, and holds the assembled text. Templates are versioned
per plan and kind and are immutable once released. Release needs: the assembly checks passing, every
variable of the map accounted for, and **no open finding from the Document Quality agent**; a person other
than its creator releases it. Checks are rerun at release, so a template cannot be released on stale results.

**AG-07 Document Quality (L1) can hold a release.** It reads the assembled template and issued documents
against the plan configuration and the filed form, and submits findings as a proposal (kind
`document_quality`): each finding quotes the text it is about, and the platform checks the quote is really in
the document. An open finding blocks release until a person resolves it (accepting it means fixing the
template; rejecting it records why it is not an issue). Its model behaviour is untested here for the same
reason as the other agents: no API key.

**Documents are immutable records with the proof of what was issued.** An issued document stores the
assembled text, its PDF (in the file store) and the PDF's hash, the template or builder version, and the
policy. The PDF is checked in tests by reading its text back and comparing it with the assembled text.
Purchase confirmation, change notices and cancellation notices are produced by platform builders from the
policy record (they are not filed wording): the confirmation lists the trip cost, benefits, limits and
premium; a change notice lists what changed between two moments of the policy's history.

**Issued at bind, within the transaction.** Bind issues the confirmation and, from the plan's released
templates, the schedule and the policy, so they exist the moment the policy does (and well inside 30
seconds). If a plan has no released template for a kind, bind still succeeds, the missing document is
recorded as failed with its reason, and it appears in the failed documents list: whether bind should refuse
without templates is for Assurant to confirm (production would normally refuse).

**Delivery is recorded per channel.** Each issued document gets an account delivery (available at once) and,
when the purchaser gave an address, an email delivery that the worker sends over SMTP with attachments,
retrying with back-off. Every attempt's outcome is stored; after the last attempt the delivery is `failed`
with its reason and appears in the failed list for staff to retry (a task queue joins in Increment 15). With
no SMTP server configured, email deliveries fail with that reason, not silently.

**Guide to Benefits** is a versioned document per card programme, produced from the programme, its master
policy and a plan version's benefits and limits, and linked to the programme.

## Not decided here

The wording of the confirmation and notices (ours, pending Assurant's), the retry schedule, whether bind must
refuse without released templates, and the plan link of card programmes.
