# Increment 1: Agent platform and governance (epic E15)

Design: [ADR 0002](../adr/0002-agent-platform.md). First agent: AG-10 Operations Copilot (autonomy L0).

| Story | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| E15-F01-S01 Registry | Unregistered agents cannot run | Agents are code manifests registered by the worker; each distinct prompt/model/tools/access configuration is a new **pending** version identified by a SHA-256 hash; the runtime refuses agents not in the catalogue, versions not approved, and code whose hash differs from the registered version | `agents.int.test.ts` (release gate), `agents.test.ts` (hash) |
| E15-F01-S02 Warrants | Calls outside the warrant are refused and logged; only people change warrants | Warrant document (tools with per-run limits, data access, model-turn and cost limits, escalation role, account scope) checked before **every** tool call; refusals recorded as run steps and routed to a review; warrant, budget and approval endpoints refuse any principal that is not a person | `agents.int.test.ts` (warrant refusal, call limits, people-only) |
| E15-F02-S01 Runtime and tools | Agents have no direct database access | Tools call the REST API with a per-run Ed25519 agent token; the API turns it into an `agent` principal whose permissions are warrant ∩ registered access ∩ the requester's own; RLS, validation and audit apply as for people | `agents.int.test.ts` (requester's permissions, API refusal of agent tokens) |
| E15-F02-S02 Model gateway | Model and prompt versions recorded on every run | `AnthropicGateway` (Claude API; Foundry in Azure) with per-version model and effort; refusal fallbacks enabled; every model call records requested and served models, prompt version, token usage and list-price cost | run record steps, `agents.test.ts` (fallback pricing) |
| E15-F02-S03 Guardrails | Failures logged and routed to a person | Payment card numbers (Luhn) and US SSNs redacted from questions and tool results before the model sees them; an answer that would disclose them is withheld and routed to a review; write tools refused for L0/L1 agents | `guardrails.test.ts`, `agents.int.test.ts` (sensitive data) |
| E15-F03-S01 Evaluation | Configuration agents measured on exact agreement | Versioned evaluation sets with deterministic graders and critical cases, run through the real runtime and model; approval refused unless the latest evaluation of every set passed. (Exact-agreement graders for configuration agents arrive with AG-01/AG-02.) | `agents.int.test.ts` (failed critical case blocks approval), live run below |
| E15-F03-S02 Immutable run record | Records hold inputs, evidence, tool calls, outputs and approvals | `agents.run_steps` is insert-only for the application role and guarded by an immutability trigger; run start and finish, approvals, warrants, budgets and review decisions are in the hash-chained audit trail | `agents.int.test.ts` (append-only, audit entries) |
| E15-F03-S03 Kill switch | A paused agent stops within one minute and its work routes to people | Status re-read before every model and tool call; the API also refuses a paused agent's tokens (5 s cache); queued and interrupted requests become review tasks | `agents.int.test.ts` (pause mid-run) |
| E15-F03-S04 Cost tracking | Budgets and alerts per agent | Monthly budget in whole cents with an alert threshold; spend from recorded usage; model calls stop at the budget (checked before each call, so one call may finish just over); one threshold review per month plus a metric and log alert | `agents.int.test.ts` (budget) |

## Workbench

- **Copilot**: ask a question, watch the agent's tool use as it happens, read the answer and open its run record.
- **Agent registry**: status, live version, warrant, budget and open reviews for each agent; versions with evaluation results; warrant editor (starting from the warrant proposed in code), budget, evaluation, approval and the kill switch.
- **Run record**: every step of a run, in order.
- **Agent reviews**: the queue of work agents routed to people, with resolution.

## Notes

- Evaluation runs act with the warrant's data access across all accounts, so they belong in development, test and sandbox environments with synthetic data.
- AG-10 is a P2 agent in the backlog; it is used now to prove the platform. The P1 agents (AG-01 to AG-07, AG-09) are built on this platform in their own increments.
