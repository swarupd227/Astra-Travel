# ADR 0002: Agent platform and governance (Increment 1, epic E15)

Status: accepted, 19 November 2026.

## Context

Specification section 10 requires every AI agent to be registered, to act only within a machine-checked
warrant, to use the same APIs and access rules as people, to be evaluated before release, to leave an
immutable record of every run, to be stoppable at once, and to stay within a cost budget.

## Decisions

**Agents are code plus a governed registry record.** An agent's prompt, model and tool list live in the
repository as a manifest. The worker registers each manifest version in `agents.agent_versions` with a
SHA-256 hash of its prompt and configuration. A version can run only after an AI governance lead (a
person, not the author) approves it, and only if its latest evaluation met the release threshold. Code
that no longer matches an approved hash cannot run (E15-F01-S01).

**Warrants are data, checked before every tool call.** A warrant lists permitted tools with per-run call
limits, the maximum model turns, the account scope and the escalation route. The runtime checks it before
each tool call and refuses anything outside it; refusals are recorded and routed to a person. Only people
with the AI governance role can create or change warrants, through the API (E15-F01-S02).

**Agents act through the platform API with their own identity.** For each run the runtime mints a
short-lived agent token (EdDSA, issuer `astra-agent-runtime`) carrying the agent, the run, the person it
acts for, and the permissions it may use: the intersection of the warrant, the agent's declared data
access and the requesting person's own permissions and account scope. Tools call the REST API with that
token, so row-level security, permission checks, validation and audit apply exactly as for people.
Agents have no database access (E15-F02-S01).

**Model gateway.** One interface over the Anthropic SDK (Claude API locally; Claude in Microsoft Foundry
in Azure). The model is chosen per agent version. Every model call records the requested model, the model
that actually served it, the prompt version, token usage and cost. Requests opt into server-side
refusal fallbacks (`fallbacks: "default"`), so the served model is always recorded (E15-F02-S02).

**Guardrails as policy code** run on the input before the model sees it and on every model output and
tool result: payment card numbers (Luhn-checked) and US social security numbers are redacted, and a run
whose output would disclose them is stopped and routed to a person. Tools that the specification forbids
agents (publishing, declining cover, overriding sanctions, changing warrants) are never in the tool
catalogue, and write tools are refused for L0 and L1 agents regardless of warrant (E15-F02-S03).

**Immutable run record.** Every run and each step (guardrail decision, warrant check, model call, tool
call and result, escalation) is appended to `agents.run_steps`, which the application role can insert into
but never update or delete; the run's start and end are also written to the hash-chained audit trail
(E15-F03-S02).

**Kill switch.** Pausing an agent is a single audited action. The runtime re-reads the agent's status
before every model and tool call, so a running agent stops within one step (well under a minute); its
queued and interrupted work becomes review tasks for people (E15-F03-S03).

**Budgets.** Each agent has a monthly budget in US dollars with an alert threshold. Spend is computed
from recorded usage at list price. Crossing the threshold raises an event, a metric and a review task;
reaching the budget stops new model calls (E15-F03-S04).

**Evaluation.** Each agent has versioned evaluation sets of cases with deterministic graders (expected
and forbidden tool calls, required and forbidden content). An evaluation run executes every case through
the real runtime and model and stores per-case results. A version cannot be approved unless its latest
evaluation meets the set's threshold (E15-F03-S01).

## First agent

Increment 1 ships one agent to prove the platform end to end: **AG-10 Operations Copilot** at autonomy
L0 (answers questions, takes no action), with read-only tools over the data that exists today (accounts,
events and deliveries, audit trail, feature flags). AG-10 is a P2 agent in the backlog; its policy-data
tools arrive with the policy modules. The P1 agents (AG-01 to AG-07, AG-09) are built on this platform in
their own increments.
