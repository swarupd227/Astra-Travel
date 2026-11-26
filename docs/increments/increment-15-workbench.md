# Increment 15: Workbench

Design: [ADR 0016](../adr/0016-workbench.md). Builds on referrals (Increment 7), agent proposals (Increment 8),
quote and bind (Increment 9), delivery (Increment 10) and the agent platform (Increment 2).

Everything in the tests is **synthetic**: people, accounts, trips, rules and the 2,000 copied policies used to time
search. The agent's model is **scripted** in the tests: `ANTHROPIC_API_KEY` is not set, so AG-04 has never been run
against Claude and its evaluation set has only been passed by the script.

| Story | Criterion | Status | Implementation and proof |
|---|---|---|---|
| E11-F01-S01 Policy search | Results within 2 seconds | Met at the tested size | By number, traveller, account, destination or trip date, each through its own index. `workbench.int.test.ts` asserts under 2 s over 2,000 policies; production volume is not tested |
| | Respects access rights | Met | Row-level security: a partner finds only its own account's policies (`workbench.int.test.ts`, `tenancy.int.test.ts`) |
| E11-F02-S01 One queue | Priority, timer and owner | Met | Referrals, sanctions holds, agent proposals, agent reviews and failed deliveries in one view with priority, time left and holder. **Timer values are placeholders**: the specification gives none |
| | Supervisors can reassign | Met | Take and hand back for anyone who works the queue; giving work to another person needs a supervisor; audited. A person can be given work only after they have signed in once |
| E11-F02-S02 Agent output review | Shows inputs, evidence, reasoning and warrant limits | Met | The review page of a run: question, every tool call and answer, platform checks, final answer, warrant |
| | The decision is recorded for evaluation | Met for referral summaries | Accept, edit or reject with a reason, immutable, read back per agent. Other agents' output keeps its existing proposal and review resolutions, which are not copied into this record |
| E03-F05-S01 Referrals | The referral agent summarises the case and the triggering rule | Met with a scripted model | AG-04 (L1) on request; the platform refuses a summary citing a rule that did not fire |
| | Decision and reason returned to the channel | Met | `ReferralDecided` carries the reason and is published to the quote's account |
| | Declines always need a human decision | Met | The agent has no decision tool; the decision route accepts only a person |

## What is built

- **Database** (`0020_workbench.sql`): trigram search indexes, `workbench.queue` (a view), timer settings, assignments,
  signed-in staff, `agents.output_decisions` and `underwriting.referral_summaries`.
- **API**: search, queue, assignees, assignment, timers, referral summaries, summary decisions, run review and the
  decision record. New permissions `tasks:read`, `tasks:work`, `tasks:assign`.
- **Agent**: AG-04 Underwriting Referral with the tools `get_referral`, `get_quote` and `submit_referral_summary`.
- **Workbench**: Work queue, Find a policy, the agent's summary on a referral, and the run review page.

## To confirm with Assurant

- Response times and priorities for each kind of work, and whether they count business hours.
- Where the list of staff should come from (the identity provider's directory) instead of "has signed in".
- Whether every referral should be summarised automatically when it is raised.
- Whether decisions on other agents' output should join the same evaluation record.
