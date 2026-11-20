import Link from 'next/link';
import { Bot, ChevronRight } from 'lucide-react';
import { ROLE_LABELS, type AgentSummary, type Role } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { BudgetBar } from '@/components/budget-bar';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader, StatusDot } from '@/components/ui/primitives';

export const metadata = { title: 'Agent registry' };

export default async function AgentsPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('agents:read')) return <AccessDenied permission="agents:read" />;
  const result = await load(() => api<{ items: AgentSummary[] }>('/v1/agents'));

  return (
    <>
      <PageHeader
        eyebrow="AI agents"
        title="Agent registry"
        description="Every AI agent the platform may run. An agent serves requests only when a person has approved its version after a passed evaluation, set its warrant and budget, and it is not paused."
      />
      {result.error ? (
        <ErrorPanel error={result.error} />
      ) : result.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bot className="size-5" />}
            title="No agents registered"
            description="Agents register when the worker starts."
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {result.data.items.map((a) => {
            const live =
              a.status === 'active' &&
              a.liveVersion !== null &&
              a.warrantVersion !== null &&
              a.budget !== null;
            return (
              <Link
                key={a.id}
                href={`/agents/${a.id}`}
                className="group rounded-xl border border-border bg-surface p-5 shadow-card transition hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-subtle">{a.id}</p>
                    <h2 className="mt-0.5 text-[15px] font-semibold text-fg group-hover:text-primary">
                      {a.name}
                    </h2>
                  </div>
                  <ChevronRight aria-hidden className="size-4 text-subtle" />
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-muted">{a.purpose}</p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Badge tone={live ? 'success' : a.status === 'paused' ? 'danger' : 'warning'}>
                    <StatusDot
                      tone={live ? 'success' : a.status === 'paused' ? 'danger' : 'warning'}
                    />
                    {a.status === 'paused' ? 'Paused' : live ? 'Live' : 'Not live'}
                  </Badge>
                  <Badge tone="primary">Autonomy {a.autonomy}</Badge>
                  <Badge>{a.liveVersion ? `v${a.liveVersion} live` : 'No approved version'}</Badge>
                  {a.latestVersion !== a.liveVersion ? (
                    <Badge tone="warning">v{a.latestVersion} awaiting approval</Badge>
                  ) : null}
                  {a.openReviews ? (
                    <Badge tone="danger">
                      {a.openReviews} open review{a.openReviews === 1 ? '' : 's'}
                    </Badge>
                  ) : null}
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-sm">
                  <div>
                    <dt className="text-xs text-subtle">Model</dt>
                    <dd className="font-mono text-xs text-fg">{a.model}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-subtle">Owner</dt>
                    <dd className="text-fg">{ROLE_LABELS[a.ownerRole as Role] ?? a.ownerRole}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="sr-only">Budget</dt>
                    <dd>
                      {a.budget ? (
                        <BudgetBar
                          spent={Number(a.budget.spentThisMonthUsd)}
                          limit={Number(a.budget.monthlyLimitUsd)}
                        />
                      ) : (
                        <span className="text-xs text-warning">No budget set</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
