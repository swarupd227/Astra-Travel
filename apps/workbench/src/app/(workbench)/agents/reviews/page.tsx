import Link from 'next/link';
import clsx from 'clsx';
import { CheckCircle2 } from 'lucide-react';
import type { AgentReview } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { REVIEW_KIND_LABELS } from '@/lib/agents';
import { readParams, sentenceCase, type SearchParams } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { ResolveReview } from '../agent-forms';

export const metadata = { title: 'Agent reviews' };

export default async function ReviewsPage({ searchParams }: { searchParams: SearchParams }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('agents:review')) return <AccessDenied permission="agents:review" />;
  const params = await readParams(searchParams);
  const status = params.status === 'resolved' ? 'resolved' : 'open';
  const result = await load(() =>
    api<{ items: AgentReview[] }>('/v1/agent-reviews', { query: { status, limit: 50 } }),
  );

  return (
    <>
      <PageHeader
        eyebrow="AI agents"
        title="Agent reviews"
        description="Work that agents handed to people: requests made while an agent was paused or over budget, warrant refusals, withheld answers and failures."
      />
      <nav aria-label="Review status" className="mb-4 flex gap-1 border-b border-border">
        {(['open', 'resolved'] as const).map((s) => (
          <Link
            key={s}
            href={`/agents/reviews?status=${s}`}
            aria-current={status === s ? 'page' : undefined}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2.5 text-sm font-medium',
              status === s
                ? 'border-primary text-primary'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {sentenceCase(s)}
          </Link>
        ))}
      </nav>
      {result.error ? (
        <ErrorPanel error={result.error} />
      ) : (
        <Card>
          {result.data.items.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="size-5" />}
              title={status === 'open' ? 'Nothing waiting for a person' : 'No resolved reviews yet'}
            />
          ) : (
            <ul className="divide-y divide-border">
              {result.data.items.map((r) => {
                const question = typeof r.detail.question === 'string' ? r.detail.question : null;
                return (
                  <li key={r.id} className="flex flex-wrap items-start gap-4 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={
                            r.kind === 'guardrail' || r.kind === 'warrant_refusal'
                              ? 'danger'
                              : 'warning'
                          }
                        >
                          {REVIEW_KIND_LABELS[r.kind] ?? r.kind}
                        </Badge>
                        <span className="font-mono text-xs text-subtle">{r.agentId}</span>
                        <span className="text-xs text-subtle">
                          <LocalTime iso={r.createdAt} relative />
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm font-medium text-fg">{r.summary}</p>
                      {question ? <p className="mt-1 text-sm text-muted">“{question}”</p> : null}
                      {r.status === 'resolved' ? (
                        <p className="mt-1 text-xs text-subtle">
                          {sentenceCase(r.resolution ?? '')} by {r.resolvedBy}: {r.resolutionNote}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3">
                      {r.runId ? (
                        <Link
                          href={`/agents/runs/${r.runId}`}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          Run record
                        </Link>
                      ) : null}
                      {r.status === 'open' ? <ResolveReview reviewId={r.id} /> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
