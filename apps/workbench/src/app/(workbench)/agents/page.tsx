import Link from 'next/link';
import { Bot, ChevronRight } from 'lucide-react';
import { AUTONOMY_LABELS, ROLE_LABELS, type AgentSummary, type Role } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { COPILOT_ID, usd } from '@/lib/agents';
import { AccessDenied } from '@/components/access-denied';
import { BudgetBar } from '@/components/budget-bar';
import { AgentMark } from '@/components/copilot/agent-mark';
import { ErrorPanel, load } from '@/components/error-panel';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, StatusDot } from '@/components/ui/primitives';

export const metadata = { title: 'Agent registry' };

const isLive = (a: AgentSummary) =>
  a.status === 'active' && a.liveVersion !== null && a.warrantVersion !== null && a.budget !== null;

/** What an agent may do on its own, in a few words. */
const autonomy = (level: AgentSummary['autonomy']) => AUTONOMY_LABELS[level].split(':')[0]!;

function Total({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-surface px-5 py-4">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-1">
        <span className="block text-2xl font-semibold tabular-nums tracking-tight text-fg">
          {value}
        </span>
        <span className="block text-xs text-muted">{note}</span>
      </dd>
    </div>
  );
}

function AgentCard({ agent: a }: { agent: AgentSummary }) {
  const live = isLive(a);
  const state = a.status === 'paused' ? 'Paused' : live ? 'Live' : 'Not released';
  const tone = a.status === 'paused' ? 'danger' : live ? 'success' : 'neutral';
  const missing = [
    a.warrantVersion === null ? 'a warrant' : null,
    a.budget === null ? 'a budget' : null,
    a.liveVersion === null ? 'an approved version' : null,
  ].filter(Boolean);
  return (
    <article className="group relative flex flex-col rounded-2xl border border-border bg-surface p-5 shadow-card transition-colors hover:border-primary/50">
      <div className="flex items-start gap-3">
        <AgentMark className={live ? undefined : 'opacity-40'} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-fg">
            {/* The whole card follows the name. */}
            <Link
              href={`/agents/${a.id}`}
              className="after:absolute after:inset-0 after:rounded-2xl group-hover:text-primary"
            >
              {a.name}
            </Link>
          </h3>
          <p className="text-xs text-muted">
            {a.id} · {autonomy(a.autonomy)}
          </p>
        </div>
        <Badge tone={tone}>
          <StatusDot tone={tone} />
          {state}
        </Badge>
      </div>
      <p className="mt-3 line-clamp-3 text-sm text-muted">{a.purpose}</p>
      <div className="mt-auto pt-4">
        <div className="flex flex-wrap items-center gap-2">
          {a.liveVersion ? <Badge>Version {a.liveVersion}</Badge> : null}
          {a.latestVersion !== a.liveVersion ? (
            <Badge tone="warning">Version {a.latestVersion} awaits approval</Badge>
          ) : null}
          {a.openReviews ? <Badge tone="danger">{a.openReviews} to review</Badge> : null}
        </div>
        <div className="mt-3 border-t border-border pt-3">
          {a.budget ? (
            <BudgetBar
              spent={Number(a.budget.spentThisMonthUsd)}
              limit={Number(a.budget.monthlyLimitUsd)}
            />
          ) : (
            <p className="text-xs text-muted">Needs {missing.join(', ')}.</p>
          )}
          <p className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
            <span>Owner: {ROLE_LABELS[a.ownerRole as Role] ?? a.ownerRole}</span>
            <ChevronRight aria-hidden className="size-4" />
          </p>
        </div>
      </div>
    </article>
  );
}

export default async function AgentsPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('agents:read')) return <AccessDenied permission="agents:read" />;
  const result = await load(() => api<{ items: AgentSummary[] }>('/v1/agents'));
  const agents = result.data?.items ?? [];
  const live = agents.filter(isLive);
  const rest = agents.filter((a) => !isLive(a));
  const spent = agents.reduce((sum, a) => sum + Number(a.budget?.spentThisMonthUsd ?? 0), 0);
  const limit = agents.reduce((sum, a) => sum + Number(a.budget?.monthlyLimitUsd ?? 0), 0);
  const reviews = agents.reduce((sum, a) => sum + a.openReviews, 0);

  return (
    <>
      <PageHeader
        title="Agent registry"
        description="The AI agents on this platform. Each works only after a person approves its version and sets what it may do and spend."
        actions={
          me.permissions.includes('agents:use') && live.some((a) => a.id === COPILOT_ID) ? (
            <ButtonLink href="/copilot">Open the Copilot</ButtonLink>
          ) : null
        }
      />
      {result.error ? (
        <ErrorPanel error={result.error} />
      ) : agents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bot className="size-5" />}
            title="No agents registered"
            description="Agents register when the worker starts."
          />
        </Card>
      ) : (
        <div className="space-y-8">
          <dl className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-card sm:grid-cols-3">
            <Total
              label="Agents live"
              value={`${live.length} of ${agents.length}`}
              note="Approved, within a warrant and budget"
            />
            <Total
              label="Waiting for a person"
              value={String(reviews)}
              note="Work the agents passed on"
            />
            <Total
              label="Spend this month"
              value={usd(spent, 2)}
              note={`of ${usd(limit, 2)} budgeted`}
            />
          </dl>
          {[
            { title: 'Working', items: live },
            { title: 'Not working yet', items: rest },
          ]
            .filter((group) => group.items.length)
            .map((group) => (
              <section key={group.title} aria-label={group.title}>
                <h2 className="mb-3 text-sm font-semibold text-muted">{group.title}</h2>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {group.items.map((a) => (
                    <AgentCard key={a.id} agent={a} />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
    </>
  );
}
