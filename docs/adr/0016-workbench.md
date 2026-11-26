# ADR 0016: The workbench: search, one work queue, agent output review and referral summaries

Status: accepted (Increment 15). Stories: E11-F01-S01, E11-F02-S01, E11-F02-S02, E03-F05-S01.

## Context

Referrals, agent proposals, agent reviews and failed deliveries each already had their own screen and their own
resolve action (Increments 8 to 13). A supervisor had to visit each to find out what was waiting. Policy search
matched only a number or a traveller. An agent's output could be read but nobody recorded whether it was right.
The specification gives no response times for any kind of work.

## Decisions

1. **The queue is a view, not a copy.** `workbench.queue` selects the open work from the tables that own it (open
   referrals and sanctions holds, open agent proposals, open agent reviews, failed document deliveries) and joins
   the timer settings and the assignment. Nothing is written twice, so nothing can be lost or left behind: finishing
   work on its own screen removes it from the queue. The view is `security_invoker`, so row-level security still
   decides what a person sees.
2. **Assignment is separate from the work.** `workbench.assignments` holds who has a piece of work, keyed by the
   kind and the id of the thing. A person takes or hands back their own work (`tasks:work`); only a supervisor gives
   work to someone else or takes it from them (`tasks:assign`). Each change is audited.
3. **Timers are settings, with placeholder values.** `workbench.sla_policies` gives each kind of work a priority and a
   number of hours. The specification names no response times, so the seeded values (sanctions hold 4 h urgent,
   referral 24 h high, agent review 24 h, failed delivery 24 h, agent proposal 72 h) are placeholders for Assurant
   to replace, changed in the workbench by a supervisor and audited. Hours are calendar hours; business-hour
   calendars are not modelled. A task is "due soon" in the last quarter of its time and "overdue" after it.
4. **People can be given work once they have signed in.** The identity provider is the source of truth for who people
   are, and this deployment has no directory to list them. `workbench.staff` records each person when they load
   `/v1/me` (at most every five minutes), with their permissions at the time, so a supervisor picks from people who
   can take work. Someone who has never signed in cannot be assigned work.
5. **Search is index-driven and account-scoped.** One endpoint finds a policy by part of its number, a traveller's name,
   an account's name or code, a trip's destination (country code or region) or its departure or return date. Each
   way of matching reads its own trigram or btree index and the candidates are joined once; row-level security
   limits the result to the caller's accounts, so a partner finds only its own policies. A test measures 2,000
   policies and asserts under two seconds.
6. **Agent output is judged by a person, and the judgement is a record.** `agents.output_decisions` holds accepted,
   edited or rejected with the person's reason and the original and edited text. It is never changed and gives
   evaluation the real corrections to learn from (`GET /v1/agents/:id/output-decisions`). Edits and rejections need
   a reason. A review page shows what the agent was given, every tool call and the platform's answer, its conclusion
   and the warrant it ran under.
7. **AG-04 recommends and never decides.** The Underwriting Referral agent runs at autonomy L1 with three tools: read
   a referral, read the quote, and submit a summary. It has no tool that decides. The platform checks that every rule
   code the summary cites fired on that referral and refuses any other; a sanctions hold is never summarised by an
   agent; summaries never change a referral. A decline stays a person's decision: the decision route refuses
   anything but a person and needs `referrals:decide`. The agent acts for the underwriter who asked, with at most
   their access.
8. **The decision and reason return to the channel.** `ReferralDecided` now carries the underwriter's reason and, for a
   referral raised at quote or bind, is published against the quote's account, so the channel's webhook receives it.

## Consequences

- A supervisor sees one list in priority order with timers, and reassigns from it.
- The seeded timer values must be agreed with Assurant.
- Referral summaries are written on request, by an underwriter asking the agent; there is no automatic run on every
  referral. Live runs need `ANTHROPIC_API_KEY`; the tests script the model.
- Work from sources added later (for example servicing escalations beyond agent reviews) joins by adding a branch to
  the view and a row to the timer table.
