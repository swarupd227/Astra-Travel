import Link from 'next/link';
import clsx from 'clsx';
import { ArrowRight, Bot, CheckCircle2, FileText } from 'lucide-react';
import type { z } from 'zod';
import {
  TASK_SOURCE_LABELS,
  type AgentRun,
  type AuditEntry,
  type PolicySummarySchema,
  type Proposal,
  type TaskList,
} from '@astra/contracts';
import { quickActions } from '@/lib/actions-menu';
import { activityPhrase } from '@/lib/activity';
import { getAgents } from '@/lib/agent-data';
import { api, getMe } from '@/lib/api';
import { money, sentenceCase, timeLeft } from '@/lib/format';
import { TIMER_TONES, taskWords } from '@/lib/tasks';
import { AgentMark } from '@/components/copilot/agent-mark';
import { AskBox } from '@/components/copilot/ask-box';
import { Greeting } from '@/components/greeting';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, type Tone } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { load } from '@/components/error-panel';
import { AgentRoster, AgentWork } from './home-agents';

export const metadata = { title: 'Home' };

type Page<T> = { items: T[]; nextCursor: string | null };
type Policy = z.infer<typeof PolicySummarySchema>;

const POLICY_TONES: Record<string, Tone> = {
  active: 'success',
  cancelled: 'neutral',
  expired: 'neutral',
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
    >
      {children} <ArrowRight aria-hidden className="size-4" />
    </Link>
  );
}

function Unavailable({ what }: { what: string }) {
  return (
    <p role="alert" className="px-5 py-4 text-sm text-danger">
      {what} could not be loaded. Reload the page to try again.
    </p>
  );
}

function Stat({
  label,
  value,
  href,
  tone,
  help,
}: {
  label: string;
  value: number | null;
  href: string;
  tone?: 'danger' | 'warning';
  help: string;
}) {
  const alert = tone && value ? tone : null;
  return (
    <Link
      href={href}
      className="relative overflow-hidden rounded-2xl border border-border bg-surface px-4 py-3 shadow-card transition-colors hover:border-primary/50"
    >
      <span
        aria-hidden
        className={clsx(
          'absolute inset-y-0 left-0 w-1',
          alert === 'danger' && 'bg-danger',
          alert === 'warning' && 'bg-warning',
        )}
      />
      <span className="block text-sm font-medium text-muted">{label}</span>
      <span
        className={clsx(
          'block text-2xl font-semibold tabular-nums tracking-tight',
          alert === 'danger' ? 'text-danger' : alert === 'warning' ? 'text-warning' : 'text-fg',
        )}
      >
        {value ?? '—'}
      </span>
      <span className="block text-xs text-muted">{help}</span>
    </Link>
  );
}

export default async function HomePage() {
  const me = (await getMe())!;
  const can = (p: string) => me.permissions.includes(p as never);
  const firstName = (me.name ?? '').split(' ')[0] || 'there';

  const [queue, mine, policies, audit, agents, proposals, runs] = await Promise.all([
    can('tasks:read') ? load(() => api<TaskList>('/v1/tasks', { query: { limit: 6 } })) : null,
    can('tasks:read')
      ? load(() => api<TaskList>('/v1/tasks', { query: { owner: 'me', limit: 1 } }))
      : null,
    can('policies:read')
      ? load(() => api<{ items: Policy[] }>('/v1/policies', { query: { limit: 5 } }))
      : null,
    can('audit:read')
      ? load(() => api<Page<AuditEntry>>('/v1/audit', { query: { limit: 6 } }))
      : null,
    can('agents:use') ? getAgents() : null,
    can('proposals:read')
      ? load(() =>
          api<{ items: Omit<Proposal, 'content'>[] }>('/v1/agent-proposals', {
            query: { status: 'open' },
          }),
        )
      : null,
    can('agents:use')
      ? load(() =>
          api<Page<AgentRun>>('/v1/agent-runs', { query: { purpose: 'request', limit: 4 } }),
        )
      : null,
  ]);

  const actions = quickActions(me.permissions).slice(0, 3);
  const setUpHref = can('agents:manage')
    ? '/agents/AG-10'
    : can('settings:manage')
      ? '/admin/model'
      : null;
  const counts = queue?.data?.counts;

  return (
    <div className="space-y-6">
      <section aria-labelledby="welcome" className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Greeting name={firstName} serverNow={new Date().toISOString()} />
        </div>
        {actions.length > 0 ? (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {actions.map((a, i) => (
              <ButtonLink
                key={a.href}
                href={a.href}
                variant={i === 0 ? 'primary' : 'secondary'}
                className="flex-1 sm:flex-none"
              >
                {a.label}
              </ButtonLink>
            ))}
          </div>
        ) : null}
      </section>

      {can('agents:use') ? <AskBox setUpHref={setUpHref} /> : null}

      {queue ? (
        <section aria-label="Work waiting" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Overdue"
            value={counts?.overdue ?? null}
            href="/work?timer=overdue"
            tone="danger"
            help="Past the time allowed"
          />
          <Stat
            label="Due soon"
            value={counts?.atRisk ?? null}
            href="/work?timer=at_risk"
            tone="warning"
            help="In the last quarter of the time"
          />
          <Stat
            label="Unassigned"
            value={counts?.unassigned ?? null}
            href="/work?owner=unassigned"
            help="Waiting for someone to take it"
          />
          <Stat
            label="Assigned to you"
            value={mine?.data?.total ?? null}
            href="/work?owner=me"
            help="Yours to finish"
          />
        </section>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {queue ? (
            <Card aria-labelledby="attention">
              <CardHeader
                titleId="attention"
                title="Needs attention"
                description={
                  queue.data && queue.data.total > queue.data.items.length
                    ? `The ${queue.data.items.length} most urgent of ${queue.data.total} items waiting.`
                    : 'Most urgent first.'
                }
                actions={<CardLink href="/work">Work queue</CardLink>}
              />
              {queue.error ? (
                <Unavailable what="The work queue" />
              ) : queue.data.items.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 className="size-5 text-success" />}
                  title="Nothing is waiting"
                  description="Referrals, agent work and failed deliveries appear here as they arise."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {queue.data.items.map((t) => (
                    <li key={`${t.sourceType}:${t.sourceId}`}>
                      <Link
                        href={t.link}
                        className="flex flex-col gap-2 px-5 py-3.5 hover:bg-surface-muted/60 sm:flex-row sm:items-center sm:gap-4"
                      >
                        {t.sourceType.startsWith('agent_') ? <AgentMark size="sm" /> : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">
                            {taskWords(t).title}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted">
                            {TASK_SOURCE_LABELS[t.sourceType]} ·{' '}
                            {t.owner
                              ? t.owner === me.subject
                                ? 'Yours'
                                : (t.ownerName ?? 'Assigned')
                              : 'Unassigned'}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {t.priority === 'urgent' || t.priority === 'high' ? (
                            <Badge tone={t.priority === 'urgent' ? 'danger' : 'warning'}>
                              {sentenceCase(t.priority)}
                            </Badge>
                          ) : null}
                          <Badge tone={TIMER_TONES[t.timer]}>{timeLeft(t.minutesLeft)}</Badge>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}

          {can('agents:use') ? (
            <AgentWork
              agents={agents}
              proposals={proposals?.data?.items ?? null}
              runs={runs?.data?.items ?? null}
            />
          ) : null}

          {policies ? (
            <Card aria-labelledby="recent-policies">
              <CardHeader
                titleId="recent-policies"
                title="Recent policies"
                actions={<CardLink href="/policies">All policies</CardLink>}
              />
              {policies.error ? (
                <Unavailable what="Recent policies" />
              ) : policies.data.items.length === 0 ? (
                <EmptyState
                  icon={<FileText className="size-5" />}
                  title="No policies yet"
                  description="A policy appears here when a quote is bought."
                  action={
                    can('quotes:create') ? (
                      <ButtonLink href="/quotes/new">New quote</ButtonLink>
                    ) : undefined
                  }
                />
              ) : (
                <ul className="divide-y divide-border">
                  {policies.data.items.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/policies/${p.id}`}
                        className="flex items-center gap-4 px-5 py-3.5 hover:bg-surface-muted/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">
                            {p.travellers.join(', ') || p.number}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted">
                            {p.number} · {p.planCode} · {p.state}
                          </span>
                        </span>
                        <span className="hidden text-sm tabular-nums text-fg sm:block">
                          {money(p.premiumTotal)}
                        </span>
                        <Badge tone={POLICY_TONES[p.status]}>{sentenceCase(p.status)}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>

        <div className="min-w-0 space-y-6">
          {can('agents:use') ? <AgentRoster agents={agents} canOpen={can('agents:read')} /> : null}

          {audit ? (
            <Card aria-labelledby="recent-activity">
              <CardHeader
                titleId="recent-activity"
                title="Recent activity"
                actions={<CardLink href="/governance/audit">Audit trail</CardLink>}
              />
              {audit.error ? (
                <Unavailable what="Recent activity" />
              ) : audit.data.items.length === 0 ? (
                <EmptyState
                  title="No activity yet"
                  description="Changes and approvals will appear here."
                />
              ) : (
                <ul className="space-y-4 px-5 py-4">
                  {audit.data.items.map((a) => {
                    const who = a.actorName ?? a.actorId;
                    return (
                      <li key={a.id} className="flex gap-3">
                        <span
                          aria-hidden
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[11px] font-semibold text-muted"
                        >
                          {a.actorType === 'agent' ? <Bot className="size-4" /> : initials(who)}
                        </span>
                        <div className="min-w-0 text-sm">
                          <p className="break-words text-muted">
                            <span className="font-medium text-fg">{who}</span>{' '}
                            {activityPhrase(a.action)}
                          </p>
                          <p className="text-xs text-subtle">
                            <LocalTime iso={a.occurredAt} relative />
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
