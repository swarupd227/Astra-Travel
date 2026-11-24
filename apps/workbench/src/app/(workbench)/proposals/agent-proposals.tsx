import Link from 'next/link';
import type { AgentRun, Proposal } from '@astra/contracts';
import { api } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { load } from '@/components/error-panel';
import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { AskAgentForm, AutoRefresh } from './proposal-forms';

/**
 * What an agent has proposed for a form or manual, and the control to ask for a new proposal. The agent acts
 * with at most the signed-in person's own permissions and saves nothing; a person reviews every proposal.
 */
export async function AgentProposals({
  subjectId,
  kind,
  agentId,
  agentName,
  question,
  askLabel,
  description,
  canAsk,
  asked,
}: {
  subjectId: string;
  kind: Proposal['kind'];
  agentId: string;
  agentName: string;
  question: string;
  askLabel: string;
  description: string;
  canAsk: boolean;
  asked?: string | undefined;
}) {
  const list = await load(() => api<{ items: Omit<Proposal, 'content'>[] }>(`/v1/agent-proposals?subjectId=${subjectId}&kind=${kind}`));
  const run = asked && /^[0-9a-f-]{36}$/i.test(asked) ? await load(() => api<AgentRun>(`/v1/agent-runs/${asked}`)) : null;
  const working = run?.data ? run.data.status === 'queued' || run.data.status === 'running' : false;
  const items = list.data?.items ?? [];
  return (
    <Card className="mb-6">
      <CardHeader title={`${agentName} (${agentId})`} description={description} actions={canAsk ? <AskAgentForm agentId={agentId} agentName={agentName} question={question} label={askLabel} /> : null} />
      <div className="space-y-3 p-5">
        <AutoRefresh active={working} />
        {run?.data && !working && run.data.status !== 'completed' ? (
          <p className="text-sm text-danger" role="alert">
            The agent’s run ended as “{run.data.status}”{run.data.stopReason ? ` (${run.data.stopReason.replace(/_/g, ' ')})` : ''}. See the agent run log for the steps.
          </p>
        ) : null}
        {items.length === 0 && !working ? <p className="text-sm text-muted">No proposals yet.</p> : null}
        {items.length ? (
          <ul className="divide-y divide-border">
            {items.map((p) => {
              const attention = p.verification.filter((c) => !c.ok).length;
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <Link href={`/proposals/${p.id}`} className="text-sm font-medium text-fg hover:text-primary hover:underline">
                      {p.summary.length > 140 ? `${p.summary.slice(0, 140)}…` : p.summary}
                    </Link>
                    <p className="text-xs text-muted">
                      <LocalTime iso={p.createdAt} /> · {p.verification.length} item{p.verification.length === 1 ? '' : 's'}
                      {attention ? ` · ${attention} to check` : ''}
                    </p>
                  </div>
                  <Badge tone={p.status === 'open' ? 'warning' : p.status === 'resolved' ? 'success' : 'neutral'}>{sentenceCase(p.status)}</Badge>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
