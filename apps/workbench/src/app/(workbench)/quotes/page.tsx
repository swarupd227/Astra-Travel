import Link from 'next/link';
import { Calculator } from 'lucide-react';
import type { Account } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { formatDay, money, sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { ButtonLink } from '@/components/ui/button';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';

export const metadata = { title: 'Quotes' };

type Item = {
  id: string;
  accountId: string;
  status: 'open' | 'bound' | 'expired';
  revision: number;
  createdAt: string;
  expiresAt: string;
  state: string;
  outcome: 'eligible' | 'ineligible' | 'referred' | 'held';
  bindable: boolean;
  planCode: string;
  total: string | null;
};

const OUTCOME = {
  eligible: 'success',
  ineligible: 'danger',
  referred: 'warning',
  held: 'warning',
} as const;
const STATUS = { open: 'Open', bound: 'Bought', expired: 'Expired' } as const;
const VIEWS = ['all', 'open', 'attention', 'bound', 'expired'] as const;
type View = (typeof VIEWS)[number];
const LABELS: Record<View, string> = {
  all: 'All',
  open: 'Open',
  attention: 'Needs an underwriter',
  bound: 'Bought',
  expired: 'Expired',
};
const LIMIT = 50;

const inView = (q: Item, view: View) =>
  view === 'all'
    ? true
    : view === 'attention'
      ? q.status === 'open' && (q.outcome === 'referred' || q.outcome === 'held')
      : q.status === view;

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('quotes:read')) return <AccessDenied permission="quotes:read" />;
  const asked = (await searchParams).view;
  const view = VIEWS.find((v) => v === asked) ?? 'all';
  const [res, accounts] = await Promise.all([
    load(() => api<{ items: Item[] }>('/v1/quotes', { query: { limit: LIMIT } })),
    me.permissions.includes('accounts:read')
      ? load(() => api<{ items: Account[] }>('/v1/accounts', { query: { limit: 100 } }))
      : null,
  ]);
  if (res.error) return <ErrorPanel error={res.error} />;
  const all = res.data.items;
  const items = all.filter((q) => inView(q, view));
  const names = new Map(accounts?.data?.items.map((a) => [a.id, a.name]) ?? []);
  const canCreate = me.permissions.includes('quotes:create');

  return (
    <>
      <PageHeader
        title="Quotes"
        description="Prices offered to travellers, with the eligibility decision for each."
        actions={
          canCreate ? (
            <ButtonLink href="/quotes/new" variant="primary">
              <Calculator aria-hidden className="size-4" /> New quote
            </ButtonLink>
          ) : null
        }
      />
      <Card>
        <FilterTabs
          label="Quote views"
          tabs={VIEWS.map((v) => ({
            href: withQuery('/quotes', {}, { view: v === 'all' ? null : v }),
            label: LABELS[v],
            current: v === view,
            count: all.filter((q) => inView(q, v)).length,
            tone: v === 'attention' ? 'warning' : undefined,
          }))}
        />
        {all.length === LIMIT ? (
          <p className="border-b border-border px-4 py-2.5 text-sm text-muted">
            Showing the {LIMIT} newest quotes.
          </p>
        ) : null}
        {items.length === 0 ? (
          <EmptyState
            icon={<Calculator className="size-5" />}
            title={view === 'all' ? 'No quotes yet' : 'No quote in this view'}
            description="Quotes made here or by a partner appear in this list."
            action={
              canCreate && view === 'all' ? (
                <ButtonLink href="/quotes/new">New quote</ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <Table caption="Quotes">
            <THead>
              <tr>
                <TH>Quote</TH>
                <TH>Plan</TH>
                <TH>Decision</TH>
                <TH>Status</TH>
                <TH className="text-right">Premium</TH>
                <TH>Made</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((q) => (
                <TR key={q.id}>
                  <TD>
                    <Link href={`/quotes/${q.id}`} className="group block">
                      <span className="block font-semibold text-fg group-hover:text-primary group-hover:underline">
                        {names.get(q.accountId) ?? 'Quote'}
                      </span>
                      <span className="block text-xs text-muted">
                        {q.id.slice(0, 8).toUpperCase()}
                        {q.revision > 1 ? ` · revision ${q.revision}` : ''}
                      </span>
                    </Link>
                  </TD>
                  <TD>
                    {q.planCode}
                    <span className="block text-xs text-muted">State {q.state}</span>
                  </TD>
                  <TD>
                    <Badge tone={OUTCOME[q.outcome]}>{sentenceCase(q.outcome)}</Badge>
                  </TD>
                  <TD>
                    {STATUS[q.status]}
                    {q.status === 'open' ? (
                      <span className="block text-xs text-muted">
                        Until {formatDay(q.expiresAt.slice(0, 10))}
                      </span>
                    ) : null}
                  </TD>
                  <TD className="text-right tabular-nums">{q.total ? money(q.total) : '—'}</TD>
                  <TD className="text-muted">
                    <LocalTime iso={q.createdAt} relative />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
