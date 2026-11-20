import type { AgentManifest } from '../manifest';
import { AG10 } from './ag-10-operations-copilot';

/** Every agent the platform may run. An agent not listed here cannot be registered or run. */
export const AGENT_MANIFESTS: readonly AgentManifest[] = [AG10];

export function manifestFor(agentId: string): AgentManifest | undefined {
  return AGENT_MANIFESTS.find((m) => m.id === agentId);
}
