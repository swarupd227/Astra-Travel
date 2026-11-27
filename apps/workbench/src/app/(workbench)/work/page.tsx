import Link from 'next/link';
import { Inbox } from 'lucide-react';
import {
  TASK_PRIORITIES,
  TASK_SOURCES,
  TASK_SOURCE_LABELS,
  type SlaPolicy,
  type Task,
  type TaskList,
} from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import type { Tone } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { assignTask, handBack, saveSla, takeTask } from './actions';

export const metadata = { title: 'Work queue' };

const PRIORITY_TONES: Record<Task['priority'], Tone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
};
const TIMER_TONES: Record<Task['timer'], Tone> = {
  overdue: 'danger',
  at_risk: 'warning',
  on_track: 'neutral',
};

/** "2 h 10 min left" or "overdue by 1 h 30 min". */
function timeLeft(minutes: number): string {
  const m = Math.abs(minutes);
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  const span =
    days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${mins} min` : `${mins} min`;
  return minutes < 0 ? `Overdue by ${span}` : `${span} left`;
}

const TIMER_LABELS: Record<Task['timer'], string> = {
  overdue: 'Overdue',
  at_risk: 'Due soon',
  on_track: 'On track',
};

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
    ? sp.source
    : undefined;
  const owner = sp.owner === 'me' || sp.owner === 'unassigned' ? sp.owner : undefined;
  const timer =
    sp.timer === 'overdue' || sp.timer === 'at_risk' || sp.timer === 'on_track'
      ? sp.timer
      : undefined;
  const canWork = me.permissions.includes('tasks:work');
  const supervisor = me.permissions.includes('tasks:assign');
  const [queue, people, sla] = await Promise.all([
    load(() => api<TaskList>('/v1/tasks', { query: { source, owner, timer, limit: 100 } })),
    supervisor
      ? load(() =>
          api<{ items: { subject: string; name: string | null; open: number }[] }>(
            '/v1/task-assignees',
          ),
        )
      : Promise.resolve(null),
    load(() => api<{ items: SlaPolicy[] }>('/v1/task-sla')),
  ]);
  if (queue.error) return <ErrorPanel error={queue.error} />;
  const { items, counts, total } = queue.data;
  const assignees = people?.data?.items ?? [];
  return (
    <>
      <PageHeader
        eyebrow="Workbench"
        title="Work queue"
        description="Everything that waits for a person: referrals and sanctions holds, agent proposals and reviews, and documents that failed to deliver. Each shows its priority, the time left, and who holds it. Work leaves the queue when it is finished on its own screen."
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

      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Waiting', total],
          ['Overdue', counts.overdue],
          ['Due soon', counts.atRisk],
          ['Unassigned', counts.unassigned],
        ].map(([label, n]) => (
          <div
            key={label as string}
            className="rounded-xl border border-border bg-surface p-4 shadow-card"
          >
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-fg">{n}</dd>
          </div>
        ))}
      </dl>

      <Card className="mb-6">
        <form
          method="get"
          className="flex flex-wrap items-end gap-3 p-4"
          aria-label="Filter the queue"
        >
          <label className="text-sm">
            <span className="mb-1 block font-medium text-fg">Kind of work</span>
            <Select name="source" defaultValue={source ?? ''}>
              <option value="">All kinds</option>
              {TASK_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {TASK_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-fg">Held by</span>
            <Select name="owner" defaultValue={owner ?? ''}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
              <option value="unassigned">Nobody (unassigned)</option>
            </Select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-fg">Timer</span>
            <Select name="timer" defaultValue={timer ?? ''}>
              <option value="">Any</option>
              <option value="overdue">Overdue</option>
              <option value="at_risk">Due soon</option>
              <option value="on_track">On track</option>
            </Select>
          </label>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          <Link
            href="/work"
            className="pb-2 text-sm font-medium text-muted hover:text-fg hover:underline"
          >
            Clear
          </Link>
        </form>
      </Card>

      <Card>
        {items.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-5" />}
            title="Nothing waiting"
            description="Referrals, agent work and failed deliveries appear here as they arise."
          />
        ) : (
          <Table caption="Work waiting for a person">
            <THead>
              <tr>
                <TH>Priority</TH>
                <TH>Task</TH>
                <TH>Timer</TH>
                <TH>Held by</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {items.map((t) => {
                const mine = t.owner === me.subject;
                return (
                  <TR key={`${t.sourceType}:${t.sourceId}`}>
                    <TD>
                      <Badge tone={PRIORITY_TONES[t.priority]}>{sentenceCase(t.priority)}</Badge>
                    </TD>
                    <TD>
                      <Link
                        href={t.link}
                        className="font-medium text-fg hover:text-primary hover:underline"
                      >
                        {t.title}
                      </Link>
                      <p className="mt-0.5 max-w-xl text-xs text-muted">
                        {TASK_SOURCE_LABELS[t.sourceType]} · {t.summary}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        Raised <LocalTime iso={t.createdAt} />
                      </p>
                    </TD>
                    <TD className="whitespace-nowrap">
                      <Badge tone={TIMER_TONES[t.timer]}>{TIMER_LABELS[t.timer]}</Badge>
                      <p className="mt-1 text-xs text-muted">{timeLeft(t.minutesLeft)}</p>
                    </TD>
                    <TD>
                      {t.owner ? (
                        mine ? (
                          'You'
                        ) : (
                          (t.ownerName ?? t.owner)
                        )
                      ) : (
                        <span className="text-muted">Nobody</span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-2">
                        {canWork && !t.owner ? (
                          <form action={takeTask}>
                            <input type="hidden" name="sourceType" value={t.sourceType} />
                            <input type="hidden" name="sourceId" value={t.sourceId} />
                            <Button type="submit" size="sm">
                              Take it<span className="sr-only">: {t.title}</span>
                            </Button>
                          </form>
                        ) : null}
                        {t.owner && (mine || supervisor) ? (
                          <form action={handBack}>
                            <input type="hidden" name="sourceType" value={t.sourceType} />
                            <input type="hidden" name="sourceId" value={t.sourceId} />
                            <Button
                              type="submit"
                              size="sm"
                              variant="secondary"
                              aria-label={`Hand back ${t.title}`}
                            >
                              Hand back
                            </Button>
                          </form>
                        ) : null}
                        {supervisor && assignees.length > 0 ? (
                          <form action={assignTask} className="flex items-center gap-1">
                            <input type="hidden" name="sourceType" value={t.sourceType} />
                            <input type="hidden" name="sourceId" value={t.sourceId} />
                            <label className="sr-only" htmlFor={`assign-${t.sourceId}`}>
                              Give {t.title} to
                            </label>
                            <Select
                              id={`assign-${t.sourceId}`}
                              name="owner"
                              defaultValue=""
                              className="h-8 w-40 text-xs"
                            >
                              <option value="" disabled>
                                Give to…
                              </option>
                              {assignees.map((p) => (
                                <option key={p.subject} value={p.subject}>
                                  {p.name ?? p.subject} ({p.open})
                                </option>
                              ))}
                            </Select>
                            <Button type="submit" size="sm" variant="secondary">
                              Give
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {sla.data ? (
        <Card className="mt-6">
          <CardHeader
            title="How long work may wait"
            description={
              supervisor
                ? 'The timers above run from when the work was raised. The specification gives no response times, so these are starting values to agree with Assurant; change them here.'
                : 'The timers above run from when the work was raised. A supervisor sets them.'
            }
          />
          <ul className="divide-y divide-border">
            {sla.data.items.map((s) => (
              <li
                key={s.sourceType}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <span className="text-sm font-medium text-fg">
                  {TASK_SOURCE_LABELS[s.sourceType]}
                </span>
                {supervisor ? (
                  <form action={saveSla} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="sourceType" value={s.sourceType} />
                    <label className="text-xs">
                      <span className="mb-1 block text-muted">Priority</span>
                      <Select name="priority" defaultValue={s.priority} className="h-8 text-xs">
                        {TASK_PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {sentenceCase(p)}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="text-xs">
                      <span className="mb-1 block text-muted">Hours to act</span>
                      <Input
                        name="targetHours"
                        type="number"
                        min={1}
                        max={720}
                        defaultValue={s.targetHours}
                        className="h-8 w-24 text-xs"
                      />
                    </label>
                    <Button
                      type="submit"
                      size="sm"
                      variant="secondary"
                      aria-label={`Save the timer for ${TASK_SOURCE_LABELS[s.sourceType]}`}
                    >
                      Save
                    </Button>
                  </form>
                ) : (
                  <span className="text-sm text-muted">
                    {sentenceCase(s.priority)}, {s.targetHours} h
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
