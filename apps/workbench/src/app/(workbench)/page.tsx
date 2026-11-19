import Link from 'next/link';
import { ArrowRight, CheckCircle2, CircleAlert } from 'lucide-react';
import { ROLE_LABELS, type Account, type AuditEntry, type Delivery } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { visibleNavigation } from '@/lib/navigation';
import { NavIcon } from '@/components/shell/nav-icon';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { load } from '@/components/error-panel';

export const metadata = { title: 'Home' };

type Page<T> = { items: T[]; nextCursor: string | null };

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: 'America/New_York',
    }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default async function HomePage() {
  const me = (await getMe())!;
  const can = (p: string) => me.permissions.includes(p as never);
  const firstName = (me.name ?? '').split(' ')[0] || 'there';

  const [dead, audit, accounts] = await Promise.all([
    can('events:read')
      ? load(() =>
          api<Page<Delivery>>('/v1/event-deliveries', { query: { status: 'dead', limit: 5 } }),
        )
      : null,
    can('audit:read')
      ? load(() => api<Page<AuditEntry>>('/v1/audit', { query: { limit: 6 } }))
      : null,
    can('accounts:read')
      ? load(() => api<Page<Account>>('/v1/accounts', { query: { limit: 5 } }))
      : null,
  ]);

  const tools = visibleNavigation(me.permissions)
    .flatMap((s) => s.items)
    .filter((i) => i.href !== '/');

  return (
    <div className="space-y-8">
      <section
        aria-labelledby="welcome"
        className="relative overflow-hidden rounded-2xl bg-sidebar px-6 py-7 text-white sm:px-8"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-[#7aa0ff]/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-28 right-40 size-64 rounded-full bg-[#4fd1bd]/15 blur-3xl"
        />
        <p className="text-sm font-medium text-[#8fb0ff]">Astra Travel workbench</p>
        <h1 id="welcome" className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {greeting()}, {firstName}
        </h1>
        <div className="mt-4 flex flex-wrap gap-2">
          {me.roles.map((r) => (
            <span
              key={r}
              className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white ring-1 ring-inset ring-white/15"
            >
              {ROLE_LABELS[r]}
            </span>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {dead ? (
            <Card aria-labelledby="attention">
              <CardHeader
                titleId="attention"
                title="Needs attention"
                description="Event deliveries that used up their retries."
                actions={
                  <Link
                    href="/operations/events?view=dead"
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Open dead-letter queue
                  </Link>
                }
              />
              {dead.error ? (
                <p className="px-5 py-4 text-sm text-danger">
                  Delivery status could not be loaded.
                </p>
              ) : dead.data.items.length === 0 ? (
                <div className="flex items-center gap-3 px-5 py-5 text-sm text-muted">
                  <CheckCircle2 aria-hidden className="size-5 text-success" />
                  Every event has been delivered or is still being retried.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {dead.data.items.map((d) => (
                    <li
                      key={`${d.eventId}-${d.subscriber}`}
                      className="flex items-start gap-3 px-5 py-3.5"
                    >
                      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-fg">
                          {d.eventType} <span className="font-normal text-muted">to</span>{' '}
                          {d.subscriber}
                        </p>
                        <p className="truncate text-xs text-muted">{d.lastError}</p>
                      </div>
                      <span className="text-xs text-subtle">
                        <LocalTime iso={d.updatedAt} relative />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}

          {audit ? (
            <Card aria-labelledby="recent-activity">
              <CardHeader
                titleId="recent-activity"
                title="Recent activity"
                description="The latest entries in the audit trail."
                actions={
                  <Link
                    href="/governance/audit"
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    View audit trail
                  </Link>
                }
              />
              {audit.error ? (
                <p className="px-5 py-4 text-sm text-danger">
                  Recent activity could not be loaded.
                </p>
              ) : audit.data.items.length === 0 ? (
                <EmptyState
                  title="No activity yet"
                  description="Changes and approvals will appear here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {audit.data.items.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                      <Badge
                        tone={
                          a.actorType === 'agent'
                            ? 'warning'
                            : a.actorType === 'partner'
                              ? 'primary'
                              : 'neutral'
                        }
                      >
                        {a.actorType}
                      </Badge>
                      <p className="min-w-0 flex-1 truncate text-sm text-fg">
                        <span className="font-medium">{a.actorName ?? a.actorId}</span>{' '}
                        <span className="text-muted">{a.action.replace(/[._]/g, ' ')}</span>
                      </p>
                      <span className="text-xs text-subtle">
                        <LocalTime iso={a.occurredAt} relative />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}

          {!dead && !audit ? (
            <Card>
              <EmptyState
                title="Your workspace is ready"
                description="Product Studio, rating, policies and the other policy modules are added to this workspace as they are released. Your role will see them automatically."
              />
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card aria-labelledby="tools">
            <CardHeader titleId="tools" title="Your tools" />
            <ul className="divide-y divide-border">
              {tools.map((t) => (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    className="group flex items-start gap-3 px-5 py-3.5 hover:bg-surface-muted/60"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                      <NavIcon name={t.icon} className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-fg">{t.label}</span>
                      <span className="block text-xs text-muted">{t.description}</span>
                    </span>
                    <ArrowRight
                      aria-hidden
                      className="mt-1 size-4 text-subtle transition-transform group-hover:translate-x-0.5"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {accounts && !accounts.error ? (
            <Card aria-labelledby="accounts-summary">
              <CardHeader titleId="accounts-summary" title="Accounts" />
              {accounts.data.items.length === 0 ? (
                <EmptyState title="No accounts yet" />
              ) : (
                <ul className="divide-y divide-border">
                  {accounts.data.items.map((a) => (
                    <li key={a.id}>
                      <Link
                        href={`/accounts/${a.id}`}
                        className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-muted/60"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-fg">
                            {a.name}
                          </span>
                          <span className="block font-mono text-xs text-muted">{a.code}</span>
                        </span>
                        <Badge>{a.status}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
