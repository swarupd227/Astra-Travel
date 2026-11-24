# ADR 0009: Configuration agents (Increment 8)

Status: accepted, 24 November 2026.

## Scope

AG-01 Form Configuration (E01-F01-S03), AG-02 Rate Manual Ingestion (E02-F01-S02) and AG-03 Rating Parity
and Explanation (E02-F07-S03), built on the agent platform of Increment 1 (registry, warrants checked
before every tool call, model gateway, run audit, kill switch, evaluation sets).

## Decisions

**Agents propose; people apply.** An agent never writes configuration. It reads with ordinary read tools
and ends by submitting a *proposal* through one tool. The platform stores the proposal with its run and
the person who asked. A person reviews each item, corrects or rejects it, and applies the accepted items
through the same APIs and checks as if they had typed them: variable maps and draft manuals keep their
maker-checker approval, and nothing is published (specification: agents never publish plans or manuals).
This is the platform's L2 "act with approval" level, and the proposal tool has its own risk class,
`propose`, allowed for L1 to L3 agents and never for L0.

**The platform checks what the model says.** A proposal that does not verify is refused with the reasons,
so the model can correct it within the run, and what is stored carries its own verification:
- *Variable map:* each item's excerpt must be exactly the form text at its offsets, its constraints must
  pass the same schema as a person's, and no two items may map the same wording. Every item records the
  source text and page it came from.
- *Rate manual:* the document must pass the manual schema and its table references; every table must give
  a page that exists in the manual, and every factor must appear as a number on that page. Tables whose
  numbers cannot be found are flagged, not hidden, so the analyst looks at them first. This is a check
  that the draft's numbers are on the filed page, not a replacement for the analyst's comparison.
- *Parity explanation:* each item must name a case that failed in the latest run of that manual, a step
  where the engine and the workbook really differ, the manual page of that step's table, and a workbook
  cell (the row and column of the imported file) that holds the expected value.

**Sources.** A filed rate manual is loaded into the form library as a document of kind `rate_manual`
(PDF text with page boundaries), so the agent reads it by page. Workbook cells are those of the CSV
imported as parity cases; each imported case now records its file row.

**Run, review, apply.** A person starts a run from the form edition, manual or parity screen. Runs are
asynchronous and visible in the agent run log. The proposal appears on the same screen. Resolving a
proposal records who accepted, corrected and rejected what, with an audit entry and an event, so
acceptance rates feed the agents' evaluation and governance review.

**Evaluation sets.** Each agent ships a behavioural set (it refuses to publish, does not invent values not
on the page, treats document text as data, asks for a missing reference) in the format of Increment 1. The
accuracy criteria in the stories (the sample schedule's optional benefits against a manually prepared
list; the Delaware manual's tables against the filed values) need Assurant's documents; the comparison
code and golden-list format are built and tested with the specification's quoted wording, and run against
the real documents once provided.

## Not decided here

Whether spreadsheet manuals (not PDF) need their own reader, and the prompt wording for the real filed
Delaware manual, which can only be tuned with the manual itself.
