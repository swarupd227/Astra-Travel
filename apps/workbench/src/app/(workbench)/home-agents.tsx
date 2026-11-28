import Link from 'next/link';
import clsx from 'clsx';
import {
  PROPOSAL_KIND_LABELS,
  type AgentRun,
  type AgentSummary,
  type Proposal,
} from '@astra/contracts';
import { RUN_STATUS_TONES, usd } from '@/lib/agents';
import { sentenceCase } from '@/lib/format';
import { AgentMark } from '@/components/copilot/agent-mark';
import { Badge, Card, CardHeader, StatusDot, type Tone } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';

type OpenProposal = Omit<Proposal, 'content'>;

function state(agent: AgentSummary): { label: string; tone: Tone; order: number } {
  if (agent.status === 'paused') return { label: 'Paused', tone: 'warning', order: 1 };
  if (agent.status === 'retired') return { label: 'Retired', tone: 'neutral', order: 3 };
  if (agent.liveVersion) return { label: 'Live', tone: 'success', order: 0 };
  return { label: 'Not released', tone: 'neutral', order: 2 };
}

/** Which agents are working, and what each has passed to people. */
export function AgentRoster({
  agents,
  canOpen,
}: {
  agents: AgentSummary[] | null;
  canOpen: boolean;
}) {
  const sorted = [...(agents ?? [])].sort(
    (a, b) => state(a).order - state(b).order || a.id.localeCompare(b.id),
  );
  const live = sorted.filter((a) => state(a).label === 'Live').length;
  const shown = sorted.slice(0, 6);
  return (
    <Card aria-labelledby="agent-roster">
      <CardHeader
        titleId="agent-roster"
        title="Your AI agents"
        description={agents ? `${live} of ${sorted.length} live` : undefined}
        actions={
          canOpen ? (
            <Link href="/agents" className="text-sm font-medium text-primary hover:underline">
              All agents
            </Link>
          ) : null
        }
      />
      {!agents ? (
        <p role="alert" className="px-5 py-4 text-sm text-danger">
          The agents could not be loaded. Reload the page to try again.
        </p>
      ) : (
        <ul className="p-2">
          {shown.map((a) => {
            const s = state(a);
            const body = (
              <>
                <AgentMark size="sm" className={clsx(s.label !== 'Live' && 'opacity-40')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{a.name}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <StatusDot tone={s.tone} />
                    {s.label}
                  </span>
                </span>
                {a.openReviews > 0 ? <Badge tone="warning">{a.openReviews} to review</Badge> : null}
              </>
            );
            return (
              <li key={a.id}>
                {canOpen ? (
                  <Link
                    href={`/agents/${a.id}`}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-muted"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 px-3 py-2">{body}</div>
                )}
              </li>
            );
          })}
          {sorted.length > shown.length ? (
            <li className="px-3 pb-1 pt-2 text-xs text-muted">
              and {sorted.length - shown.length} more
            </li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

/** What agents have drafted for a person to check, and the latest work they were asked to do. */
export function AgentWork({
  agents,
  proposals,
  runs,
}: {
  agents: AgentSummary[] | null;
  proposals: OpenProposal[] | null;
  runs: AgentRun[] | null;
}) {
  const name = (id: string) => agents?.find((a) => a.id === id)?.name ?? id;
  const waiting = (proposals ?? []).slice(0, 4);
  const recent = (runs ?? []).slice(0, 4);
  return (
    <Card aria-labelledby="agent-work">
      <CardHeader
        titleId="agent-work"
        title="Agent work"
        description="Agents draft and suggest. A person decides."
      />
      {waiting.length === 0 && recent.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted">
          No agent has done any work you can see yet. Proposals and runs appear here.
        </p>
      ) : null}
      {waiting.length > 0 ? (
        <>
          <h3 className="px-5 pt-4 text-xs font-semibold text-muted">
            Waiting for a person to check
          </h3>
          <ul className="p-2">
            {waiting.map((p) => {
              const attention = p.verification.filter((c) => !c.ok).length;
              return (
                <li key={p.id}>
                  <Link
                    href={`/proposals/${p.id}`}
                    className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-muted"
                  >
                    <AgentMark size="sm" className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-sm font-medium text-fg">{p.summary}</span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {name(p.agentId)} · {PROPOSAL_KIND_LABELS[p.kind]} ·{' '}
                        <LocalTime iso={p.createdAt} relative />
                      </span>
                    </span>
                    {attention > 0 ? (
                      <Badge tone="warning">
                        {attention} {attention === 1 ? 'check' : 'checks'} failed
                      </Badge>
                    ) : (
                      <span className="shrink-0 text-sm font-medium text-primary">Review</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {recent.length > 0 ? (
        <>
          <h3
            className={clsx(
              'px-5 pt-4 text-xs font-semibold text-muted',
              waiting.length > 0 && 'border-t border-border',
            )}
          >
            Latest runs
          </h3>
          <ul className="p-2">
            {recent.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/agents/runs/${r.id}`}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">
                      {typeof r.input.question === 'string' ? r.input.question : name(r.agentId)}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {name(r.agentId)} · {r.requestedByName ?? r.requestedBy} ·{' '}
                      <LocalTime iso={r.createdAt} relative /> · {usd(r.costUsd, 2)}
                    </span>
                  </span>
                  <Badge tone={RUN_STATUS_TONES[r.status]}>{sentenceCase(r.status)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
