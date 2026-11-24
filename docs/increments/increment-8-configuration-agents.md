# Increment 8: Configuration agents

Design: [ADR 0009](../adr/0009-configuration-agents.md). Builds on the agent platform (Increment 1), the form
library and variable maps (Increment 3), rate manuals and parity (Increment 5).

**What was and was not verified.** The three agents are built, registered, governed (warrant, budget,
evaluation set, approval) and wired to the screens. Their behaviour against the real Claude model has not been
run: this environment has no `ANTHROPIC_API_KEY`. Everything the platform does around the model is tested
end to end with a scripted model, through the real runtime, agent tokens, API and database: what the agent
may call, what it submits, what the platform refuses, what is stored, and what a person can do with it. The
prompts are untested against the model and untuned; they must be run against the sample schedule and the
Delaware manual, which have not been provided. `apps/workbench/e2e/agents-config.live.spec.ts` runs the full
journey with a live model once a key is set.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E01-F01-S03 AG-01 | The agent proposes every variable with type, range and text location | Built; model untested | `submit_variable_map_proposal`: each item has type, filed range, exact offsets and excerpt. The platform refuses a proposal whose excerpt is not the form text at its offsets, or whose constraints fail the variable schema. `config-agents.int.test.ts` |
| | Each proposal shows the source text | Met | The review page shows the excerpt, its page and the agent's rationale beside each variable |
| | A product manager approves or corrects each variable before the map is saved | Met | Nothing is saved by the agent. The review page ticks what verified, leaves what needs a look unticked, lets the person correct label, key and range, and saves the ticked ones to the draft map through the ordinary API; the decision is recorded (accepted, corrected, rejected). `e2e/agents-config.spec.ts` |
| | On the sample schedule the agent finds all optional benefits and ranges, checked against a manually prepared list | Comparison built; sample schedule not provided | `compareToGolden` reports what is missing, mismatched or extra against a hand-made list. Tested on the specification's quoted wording; the live spec runs it with the real model |
| E02-F01-S02 AG-02 | The agent drafts every table, band and factor with a link to its page | Built; model untested | `submit_rate_manual_proposal`: the draft follows the manual format and every table names its manual page. Filed manuals are loaded into the form library as kind `rate_manual` and read page by page |
| | On the Delaware manual the drafted tables match the filed values exactly | Check built; manual not provided | The platform confirms that each table's page is found in the document and that every factor is printed as a number on that page; tables with factors not found are flagged for the analyst's closest comparison. This is a check of the draft against the page, not a replacement for the analyst's comparison |
| | Nothing is published until a rating analyst approves it | Met | The agent loads nothing. The analyst loads the draft as a draft manual; it still needs a second analyst, a filing in effect and every parity case matching |
| E02-F07-S03 AG-03 | For each difference the agent identifies the step and factor where results diverge | Built; model untested | It reads the latest parity run's factor differences and the manual's tables. The platform refuses an explanation for a case that passed or a step that does not differ |
| | The explanation cites the manual page and the workbook cell | Met | The platform checks the page is the step's table's page and the cell is the case's row in the imported file and the factor column. Imported cases now record their file row |

## Governance

Each agent has a warrant (tools and call limits), a monthly budget, a behavioural evaluation set (it asks
which document when none is given, will not save, approve or publish, will not estimate missing values or
cite what it has not checked, does not disclose its instructions or repeat card numbers) and needs approval
of its version by the AI governance lead before anyone can ask it. Until then the panels on the screens say
so when asked. AG-01 and AG-02 are L2 (act with approval) and AG-03 is L1 (recommend).

## Workbench

A panel on the form edition page (AG-01, or AG-02 for a rate manual document) and on the rate manual page
(AG-03, when parity cases fail) lists proposals and starts a run. The proposal page shows the agent's items
with the platform's checks and lets the person correct, save and reject.

## To confirm with Assurant

- The sample schedule and its manually prepared list of variables, the Delaware manual and, if available, a
  workbook, so the prompts can be tuned and measured.
- Whether manuals arrive as PDF (read today) or spreadsheet (needs its own reader).
- Acceptable cost per run and monthly budgets (the proposed values are placeholders).
