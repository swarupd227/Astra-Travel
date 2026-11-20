import type { AgentSummary } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, PageHeader } from '@/components/ui/primitives';
import { CopilotConsole } from './copilot-console';

export const metadata = { title: 'Copilot' };

export default async function CopilotPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('agents:use')) return <AccessDenied permission="agents:use" />;
  const agents = await load(() => api<{ items: AgentSummary[] }>('/v1/agents'));
  if (agents.error) return <ErrorPanel error={agents.error} />;
  const copilot = agents.data.items.find((a) => a.id === 'AG-10');

  let reason: string | null = null;
  if (!copilot) reason = 'The Operations Copilot is not registered on this platform.';
  else if (copilot.status !== 'active')
    reason = `The Operations Copilot is ${copilot.status}: ${copilot.statusReason ?? 'no reason given'}.`;
  else if (!copilot.liveVersion)
    reason =
      'The Operations Copilot has no approved version yet. An AI governance lead must evaluate and approve it.';

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        eyebrow="AI agents"
        title="Operations Copilot"
        description="Ask questions about platform operations in plain language."
        actions={
          copilot ? (
            <div className="flex items-center gap-2">
              <Badge tone="primary">Autonomy {copilot.autonomy}: reads only</Badge>
              <Badge
                tone={copilot.status === 'active' && copilot.liveVersion ? 'success' : 'warning'}
              >
                {copilot.status === 'active' && copilot.liveVersion
                  ? `Version ${copilot.liveVersion} live`
                  : 'Unavailable'}
              </Badge>
            </div>
          ) : null
        }
      />
      <CopilotConsole available={reason === null} unavailableReason={reason} />
    </div>
  );
}
