import Link from 'next/link';
import clsx from 'clsx';
import { CheckCircle2 } from 'lucide-react';
import {
  TASK_SOURCES,
  TASK_SOURCE_LABELS,
  type Account,
  type SlaPolicy,
  type Task,
  type TaskList,
  type TaskSource,
} from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase, timeLeft } from '@/lib/format';
import { TIMER_TONES, taskWords } from '@/lib/tasks';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { TaskIcon } from '@/components/task-icon';
import { Badge, Card, EmptyState, Notice, PageHeader } from '@/components/ui/primitives';
import { withQuery } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { KindFilter } from './kind-filter';
import { TaskActions, type Person } from './task-actions';
import { TimersDialog } from './timers-dialog';

export const metadata = { title: 'Work queue' };

type View = 'all' | 'overdue' | 'at_risk' | 'unassigned' | 'mine';

const EMPTY: Record<View, { title: string; description: string }> = {
  all: {
    title: 'Nothing waiting',
    description: 'Referrals, agent work and failed deliveries appear here as they arise.',
  },
  overdue: { title: 'Nothing is overdue', description: 'Every item is still within its time.' },
  at_risk: {
    title: 'Nothing is due soon',
    description: 'Items appear here in the last quarter of their time.',
  },
  unassigned: {
    title: 'Everything has an owner',
    description: 'Work that nobody has taken appears here.',
  },
  mine: {
    title: 'You hold no work',
    description: 'Take an item from the queue and it appears here until it is finished.',
  },
};

/** A question the Operations Copilot can answer from the records it reads, if there is one. */
function copilotQuestion(task: Task, canReadEvents: boolean): string | null {
  if (task.sourceType !== 'event_delivery' || !canReadEvents) return null;
  return `Why did this delivery fail, and has it happened before? ${task.title}. ${task.summary}`.slice(
    0,
    600,
  );
}

export default async function WorkQueuePage({
  searchParams,
}: {
  searchParams: Promise<{
    source?: string;
    owner?: string;
    timer?: string;
    done?: string;
    error?: string;
  }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('tasks:read')) return <AccessDenied permission="tasks:read" />;
  const sp = await searchParams;
  const source = (TASK_SOURCES as readonly string[]).includes(sp.source ?? '')
    ? (sp.source as TaskSource)
    : undefined;
  const owner = sp.owner === 'me' || sp.owner === 'unassigned' ? sp.owner : undefined;
  const timer =
    sp.timer === 'overdue' || sp.timer === 'at_risk' || sp.timer === 'on_track'
      ? sp.timer
      : undefined;
  const view: View | null =
    owner === 'me' && !timer
      ? 'mine'
      : owner === 'unassigned' && !timer
        ? 'unassigned'
        : !owner && (timer === 'overdue' || timer === 'at_risk')
          ? timer
          : !owner && !timer
            ? 'all'
            : null;
  const canWork = me.permissions.includes('tasks:work');
  const supervisor = me.permissions.includes('tasks:assign');
  const canReadEvents = me.permissions.includes('events:read');

  const [queue, totals, mine, people, sla, accounts] = await Promise.all([
    load(() => api<TaskList>('/v1/tasks', { query: { source, owner, timer, limit: 100 } })),
    load(() => api<TaskList>('/v1/tasks', { query: { source, limit: 1 } })),
    load(() => api<TaskList>('/v1/tasks', { query: { source, owner: 'me', limit: 1 } })),
    supervisor ? load(() => api<{ items: Person[] }>('/v1/task-assignees')) : null,
    load(() => api<{ items: SlaPolicy[] }>('/v1/task-sla')),
    me.permissions.includes('accounts:read')
      ? load(() => api<{ items: Account[] }>('/v1/accounts', { query: { limit: 100 } }))
      : null,
  ]);
  if (queue.error) return <ErrorPanel error={queue.error} />;
  const { items, total } = queue.data;
  const accountName = new Map(accounts?.data?.items.map((a) => [a.id, a.name]) ?? []);

  const tabs: { view: View; label: string; count: number | undefined; href: string }[] = [
    {
      view: 'all',
      label: 'All',
      count: totals.data?.total,
      href: withQuery('/work', {}, { source }),
    },
    {
      view: 'overdue',
      label: 'Overdue',
      count: totals.data?.counts.overdue,
      href: withQuery('/work', {}, { source, timer: 'overdue' }),
    },
    {
      view: 'at_risk',
      label: 'Due soon',
      count: totals.data?.counts.atRisk,
      href: withQuery('/work', {}, { source, timer: 'at_risk' }),
    },
    {
      view: 'unassigned',
      label: 'Unassigned',
      count: totals.data?.counts.unassigned,
      href: withQuery('/work', {}, { source, owner: 'unassigned' }),
    },
    {
      view: 'mine',
      label: 'Mine',
      count: mine.data?.total,
      href: withQuery('/work', {}, { source, owner: 'me' }),
    },
  ];
  const kinds = [undefined, ...TASK_SOURCES].map((s) => ({
    href: withQuery('/work', {}, { source: s, owner, timer }),
    label: s ? TASK_SOURCE_LABELS[s] : 'All kinds of work',
    selected: s === source,
  }));

  return (
    <>
      <PageHeader
        title="Work queue"
        description="Everything waiting for a person, most urgent first. An item leaves when its work is finished."
        actions={sla.data ? <TimersDialog policies={sla.data.items} editable={supervisor} /> : null}
      />
      {sp.done ? (
        <div className="mb-4">
          <Notice tone="success" title={`Done: ${sp.done}`}>
            The queue below is up to date.
          </Notice>
        </div>
      ) : null}
      {sp.error ? (
        <div className="mb-4">
          <Notice tone="danger" title="That did not work">
            {sp.error}
          </Notice>
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-border px-3">
          <nav aria-label="Queue views" className="-mb-px flex max-w-full overflow-x-auto">
            {tabs.map((t) => (
              <Link
                key={t.view}
                href={t.href}
                aria-current={view === t.view ? 'page' : undefined}
                className={clsx(
                  'flex shrink-0 items-center gap-2 border-b-2 px-3 py-3.5 text-sm font-medium focus-visible:outline-offset-[-3px]',
                  view === t.view
                    ? 'border-primary text-fg'
                    : 'border-transparent text-muted hover:border-border-strong hover:text-fg',
                )}
              >
                {t.label}
                {t.count !== undefined ? (
                  <Badge
                    className="tabular-nums"
                    tone={
                      t.count && t.view === 'overdue'
                        ? 'danger'
                        : t.count && t.view === 'at_risk'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {t.count}
                  </Badge>
                ) : null}
              </Link>
            ))}
          </nav>
          <div className="py-2">
            <KindFilter options={kinds} />
          </div>
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="size-5" />}
            {...(source
              ? {
                  title: 'Nothing of this kind here',
                  description: 'Choose another kind of work or another view.',
                }
              : EMPTY[view ?? 'all'])}
          />
        ) : (
          <ul aria-label="Work waiting for a person" className="divide-y divide-border">
            {items.map((t) => {
              const words = taskWords(t);
              const mineNow = t.owner === me.subject;
              const holder = !t.owner ? 'Unassigned' : mineNow ? 'Yours' : (t.ownerName ?? t.owner);
              const account = t.accountId ? accountName.get(t.accountId) : undefined;
              return (
                <li
                  key={`${t.sourceType}:${t.sourceId}`}
                  className="flex flex-col gap-3 px-4 py-4 hover:bg-surface-muted/40 sm:px-5 md:flex-row md:items-center"
                >
                  <div className="flex min-w-0 flex-1 gap-3">
                    <TaskIcon source={t.sourceType} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link
                          href={t.link}
                          className="break-words text-sm font-semibold text-fg hover:text-primary hover:underline"
                        >
                          {words.title}
                        </Link>
                        {t.priority === 'urgent' || t.priority === 'high' ? (
                          <Badge tone={t.priority === 'urgent' ? 'danger' : 'warning'}>
                            {sentenceCase(t.priority)}
                          </Badge>
                        ) : null}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-sm text-muted">{words.summary}</p>
                      <p className="mt-1 text-xs text-subtle">
                        {TASK_SOURCE_LABELS[t.sourceType]}
                        {account ? ` · ${account}` : ''} · raised{' '}
                        <LocalTime iso={t.createdAt} relative />
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-start gap-3 pl-11 md:flex-row md:items-center md:pl-0">
                    <div className="flex items-center gap-3 md:block md:w-40 md:text-right">
                      <Badge tone={TIMER_TONES[t.timer]}>{timeLeft(t.minutesLeft)}</Badge>
                      <p
                        className={clsx(
                          'truncate text-xs md:mt-1',
                          t.owner ? 'font-medium text-fg' : 'text-muted',
                        )}
                      >
                        {holder}
                      </p>
                    </div>
                    <div className="flex justify-end md:min-w-44">
                      <TaskActions
                        sourceType={t.sourceType}
                        sourceId={t.sourceId}
                        title={words.title}
                        ownerSubject={t.owner}
                        mine={mineNow}
                        canWork={canWork}
                        supervisor={supervisor}
                        people={people?.data?.items ?? []}
                        question={copilotQuestion(t, canReadEvents)}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {items.length > 0 && total > items.length ? (
          <p className="border-t border-border px-5 py-3 text-sm text-muted">
            Showing the {items.length} most urgent of {total}.
          </p>
        ) : null}
      </Card>
    </>
  );
}
