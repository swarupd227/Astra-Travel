import Link from 'next/link';
import clsx from 'clsx';
import { Activity, CheckCircle2 } from 'lucide-react';
import type { Delivery, EventRecord } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { DELIVERY_STATUS_TONES, readParams, sentenceCase, type SearchParams } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Pager, Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { ReplayDialog } from './replay-dialog';

export const metadata = { title: 'Events & deliveries' };

type Page<T> = { items: T[]; nextCursor: string | null };
const VIEWS = [
  { key: 'events', label: 'Events' },
  { key: 'dead', label: 'Dead-letter queue' },
  { key: 'deliveries', label: 'All deliveries' },
] as const;

export default async function EventsPage({ searchParams }: { searchParams: SearchParams }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('events:read')) return <AccessDenied permission="events:read" />;
  const params = await readParams(searchParams);
  const view = VIEWS.some((v) => v.key === params.view) ? params.view! : 'events';
  const canReplay = me.permissions.includes('events:replay');

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Events & deliveries"
        description="Every business change raises an event. Events are delivered to each subscriber at least once; deliveries that use up their retries land in the dead-letter queue."
      />
      <nav aria-label="Views" className="mb-4 flex gap-1 border-b border-border">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={`/operations/events?view=${v.key}`}
            aria-current={view === v.key ? 'page' : undefined}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2.5 text-sm font-medium',
              view === v.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {v.label}
          </Link>
        ))}
      </nav>
      {view === 'events' ? (
        <EventsView params={params} />
      ) : (
        <DeliveriesView params={params} dead={view === 'dead'} canReplay={canReplay} />
      )}
    </>
  );
}

async function EventsView({ params }: { params: Record<string, string | undefined> }) {
  const result = await load(() =>
    api<Page<EventRecord>>('/v1/events', {
      query: {
        type: params.type,
        correlationId: params.correlationId,
        cursor: params.cursor,
        limit: 25,
      },
    }),
  );
  if (result.error) return <ErrorPanel error={result.error} />;
  return (
    <Card>
      {result.data.items.length === 0 ? (
        <EmptyState
          icon={<Activity className="size-5" />}
          title="No events yet"
          description="Events appear as soon as anything changes on the platform."
        />
      ) : (
        <>
          <Table caption="Business events">
            <THead>
              <tr>
                <TH>Event</TH>
                <TH>Source</TH>
                <TH>Account</TH>
                <TH>Correlation ID</TH>
                <TH>Time</TH>
                <TH>Relayed</TH>
              </tr>
            </THead>
            <tbody>
              {result.data.items.map((e) => (
                <TR key={e.id}>
                  <TD>
                    <span className="font-medium">{e.type}</span>
                    <span className="ml-1.5 text-xs text-subtle">v{e.version}</span>
                  </TD>
                  <TD className="font-mono text-xs text-muted">{e.source}</TD>
                  <TD className="font-mono text-xs text-muted">
                    {e.accountId ? e.accountId.slice(0, 8) : '—'}
                  </TD>
                  <TD>
                    <Link
                      href={`/governance/audit?correlationId=${encodeURIComponent(e.correlationId)}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {e.correlationId.slice(0, 13)}
                    </Link>
                  </TD>
                  <TD className="text-muted">
                    <LocalTime iso={e.time} />
                  </TD>
                  <TD>
                    {e.publishedAt ? (
                      <Badge tone="success">Relayed</Badge>
                    ) : (
                      <Badge tone="primary">Waiting</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
          <Pager
            count={result.data.items.length}
            nextHref={
              result.data.nextCursor
                ? withQuery('/operations/events', params, { cursor: result.data.nextCursor })
                : null
            }
            firstHref={
              params.cursor ? withQuery('/operations/events', params, { cursor: null }) : null
            }
          />
        </>
      )}
    </Card>
  );
}

async function DeliveriesView({
  params,
  dead,
  canReplay,
}: {
  params: Record<string, string | undefined>;
  dead: boolean;
  canReplay: boolean;
}) {
  const result = await load(() =>
    api<Page<Delivery>>('/v1/event-deliveries', {
      query: { status: dead ? 'dead' : params.status, cursor: params.cursor, limit: 25 },
    }),
  );
  if (result.error) return <ErrorPanel error={result.error} />;
  return (
    <Card>
      {dead && canReplay && result.data.items.length > 0 ? (
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <p className="text-sm text-muted">
            Replaying sends a delivery again with a fresh set of retries.
          </p>
          <ReplayDialog all />
        </div>
      ) : null}
      {result.data.items.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="size-5" />}
          title={dead ? 'The dead-letter queue is empty' : 'No deliveries yet'}
          description={
            dead
              ? 'Every event has been delivered or is still being retried.'
              : 'Deliveries appear once subscribers are registered.'
          }
        />
      ) : (
        <>
          <Table caption={dead ? 'Dead-lettered deliveries' : 'Event deliveries'}>
            <THead>
              <tr>
                <TH>Event</TH>
                <TH>Subscriber</TH>
                <TH>Status</TH>
                <TH>Attempts</TH>
                <TH>Last error</TH>
                <TH>Updated</TH>
                {dead && canReplay ? <TH className="text-right">Action</TH> : null}
              </tr>
            </THead>
            <tbody>
              {result.data.items.map((d) => (
                <TR key={`${d.eventId}-${d.subscriber}`}>
                  <TD className="font-medium">{d.eventType}</TD>
                  <TD className="font-mono text-xs text-muted">{d.subscriber}</TD>
                  <TD>
                    <Badge tone={DELIVERY_STATUS_TONES[d.status]}>{sentenceCase(d.status)}</Badge>
                  </TD>
                  <TD className="tabular-nums text-muted">{d.attempts}</TD>
                  <TD className="max-w-xs text-xs text-muted">
                    <span className="line-clamp-2">{d.lastError ?? '—'}</span>
                  </TD>
                  <TD className="text-muted">
                    <LocalTime iso={d.updatedAt} />
                  </TD>
                  {dead && canReplay ? (
                    <TD className="text-right">
                      <ReplayDialog eventId={d.eventId} subscriber={d.subscriber} />
                    </TD>
                  ) : null}
                </TR>
              ))}
            </tbody>
          </Table>
          <Pager
            count={result.data.items.length}
            nextHref={
              result.data.nextCursor
                ? withQuery('/operations/events', params, { cursor: result.data.nextCursor })
                : null
            }
            firstHref={
              params.cursor ? withQuery('/operations/events', params, { cursor: null }) : null
            }
          />
        </>
      )}
    </Card>
  );
}
