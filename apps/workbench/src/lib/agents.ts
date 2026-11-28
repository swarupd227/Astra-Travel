/** Display helpers for agent screens. */
import type { AgentSummary, Permission } from '@astra/contracts';

export const COPILOT_ID = 'AG-10';

/** Why the Operations Copilot cannot answer, in words for the person asking; null when it can. */
export function copilotUnavailableReason(agents: AgentSummary[] | null): string | null {
  if (!agents) return 'The Copilot’s status could not be checked. Reload the page to try again.';
  const copilot = agents.find((a) => a.id === COPILOT_ID);
  if (!copilot) return 'The Operations Copilot is not registered on this platform.';
  if (copilot.status !== 'active')
    return `The Operations Copilot is ${copilot.status}: ${copilot.statusReason ?? 'no reason given'}.`;
  if (!copilot.liveVersion)
    return 'The Operations Copilot has no approved version yet. An AI governance lead must evaluate and approve it.';
  return null;
}

/** Starter questions the Copilot can answer with the person's own access. */
export function copilotSuggestions(permissions: readonly Permission[]): string[] {
  const all: [Permission, string][] = [
    ['accounts:read', 'Which accounts are still in onboarding?'],
    ['events:read', 'Have any event deliveries failed for good?'],
    ['audit:read', 'What changed on the platform today, and who changed it?'],
    ['flags:read', 'Which feature flags are switched on?'],
  ];
  return all.filter(([p]) => permissions.includes(p)).map(([, question]) => question);
}

export const TOOL_ACTIVITY: Record<string, string> = {
  list_accounts: 'Looking up accounts',
  get_account: 'Reading an account',
  list_events: 'Reading business events',
  list_event_deliveries: 'Checking event deliveries',
  search_audit_trail: 'Searching the audit trail',
  list_feature_flags: 'Reading feature flags',
};

/** What a person should know when a run did not produce an answer. */
export const STOP_EXPLANATIONS: Record<string, string> = {
  agent_paused: 'The agent is paused, so your question was passed to a person.',
  budget_exhausted:
    'The agent has used its budget for this month, so your question was passed to a person.',
  run_cost_limit:
    'This question needed more work than one run is allowed; a person has been asked to help.',
  max_model_turns: 'The agent could not finish within its limits; a person has been asked to help.',
  output_guardrail:
    'The answer contained sensitive data, so it was withheld and passed to a person.',
  model_refusal: 'The model declined to answer; a person has been asked to help.',
  model_error: 'The AI service could not be reached. Please try again in a moment.',
  version_not_approved: 'This version of the agent is not approved to answer questions.',
  no_active_warrant: 'The agent has no warrant, so it cannot run.',
  no_budget: 'The agent has no budget, so it cannot run.',
  code_does_not_match_registered_version:
    'The running code is not the approved version of this agent.',
  interrupted: 'The run was interrupted; a person has been asked to help.',
  runtime_error: 'The run failed with an internal error; a person has been asked to help.',
  tool_input_truncated: 'The agent ran out of room while working; a person has been asked to help.',
};

export const RUN_STATUS_TONES = {
  queued: 'neutral',
  running: 'primary',
  completed: 'success',
  failed: 'danger',
  stopped: 'warning',
  escalated: 'warning',
} as const;

export const REVIEW_KIND_LABELS: Record<string, string> = {
  warrant_refusal: 'Warrant refusal',
  guardrail: 'Guardrail',
  agent_paused: 'Agent paused',
  budget: 'Budget',
  run_failed: 'Run failed',
  model_refusal: 'Model declined',
  servicing_request: 'Servicing request for a person',
};

export function usd(value: string | number, digits = 4): string {
  return `$${Number(value).toFixed(digits)}`;
}
