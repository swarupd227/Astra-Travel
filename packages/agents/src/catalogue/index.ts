import type { AgentManifest } from '../manifest';
import { AG10 } from './ag-10-operations-copilot';
import { AG01, AG02, AG03 } from './configuration-agents';
import { AG07 } from './document-quality';
import { AG06 } from './policy-servicing';

/** Every agent the platform may run. An agent not listed here cannot be registered or run. */
export const AGENT_MANIFESTS: readonly AgentManifest[] = [AG01, AG02, AG03, AG06, AG07, AG10];

export function manifestFor(agentId: string): AgentManifest | undefined {
  return AGENT_MANIFESTS.find((m) => m.id === agentId);
}
