import { getMe } from '@/lib/api';
import { getAgents } from '@/lib/agent-data';
import { COPILOT_ID, copilotUnavailableReason } from '@/lib/agents';
import { AccessDenied } from '@/components/access-denied';
import { Conversation } from '@/components/copilot/conversation';
import { Badge, PageHeader } from '@/components/ui/primitives';

export const metadata = { title: 'Copilot' };

export default async function CopilotPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('agents:use')) return <AccessDenied permission="agents:use" />;
  const agents = await getAgents();
  const copilot = agents?.find((a) => a.id === COPILOT_ID);
  const available = copilotUnavailableReason(agents) === null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Operations Copilot"
        description="Ask questions about platform operations in plain language."
        actions={
          copilot ? (
            <div className="flex items-center gap-2">
              <Badge tone="primary">Autonomy {copilot.autonomy}: reads only</Badge>
              <Badge tone={available ? 'success' : 'warning'}>
                {available ? `Version ${copilot.liveVersion} live` : 'Unavailable'}
              </Badge>
            </div>
          ) : null
        }
      />
      <Conversation variant="page" />
    </div>
  );
}
