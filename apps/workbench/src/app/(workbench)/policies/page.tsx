import Link from 'next/link';
import clsx from 'clsx';
import { Calculator, FileText, Search } from 'lucide-react';
import type { z } from 'zod';
import type { Account, PolicySummarySchema, SearchResult } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { countryName, dayRange, money, sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Button, ButtonLink } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';

export const metadata = { title: 'Policies' };

type Summary = z.infer<typeof PolicySummarySchema>;
type Status = Summary['status'];

const TONES = { active: 'success', cancelled: 'neutral', expired: 'neutral' } as const;
const STATUSES: (Status | undefined)[] = [undefined, 'active', 'cancelled', 'expired'];
const MATCHED = {
  number: 'policy number',
  traveller: 'traveller',
  account: 'account',
  trip: 'trip',
} as const;
const LIMIT = 50;

interface Row {
  id: string;
  number: string;
  status: Status;
  travellers: string[];
  account: string | undefined;
  planCode: string;
  dates: string;
  destinations: string;
  premium: string | null;
  matched: string | null;
}

/** Every policy the person may see: the newest first, or those matching a search. */
export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('policies:read')) return <AccessDenied permission="policies:read" />;
  const params = await searchParams;
  const q = (params.q ?? '').trim().slice(0, 100);
  const status = STATUSES.find((s) => s === params.status);
  const searching = q.length >= 2;

  let rows: Row[] = [];
  let found = 0;
  if (searching) {
    const res = await load(() => api<SearchResult>('/v1/search', { query: { q, limit: LIMIT } }));
    if (res.error) return <ErrorPanel error={res.error} />;
    found = res.data.items.length;
    rows = res.data.items
      .filter((h) => !status || h.status === status)
      .map((h) => ({
        id: h.policyId,
        number: h.number,
        status: h.status,
        travellers: h.travellers,
        account: h.accountName,
        planCode: h.planCode,
        dates: dayRange(h.departureDate, h.returnDate),
        // A destination arrives as "FR · Europe": the country code is written out.
        destinations: h.destinations
          .map((d) => d.split(' · ').map(countryName).join(', '))
          .join('; '),
        premium: null,
        matched: h.matchedOn.map((m) => MATCHED[m]).join(', '),
      }));
  } else if (!q) {
    const [res, accounts] = await Promise.all([
      load(() => api<{ items: Summary[] }>('/v1/policies', { query: { status, limit: LIMIT } })),
      me.permissions.includes('accounts:read')
        ? load(() => api<{ items: Account[] }>('/v1/accounts', { query: { limit: 100 } }))
        : null,
    ]);
    if (res.error) return <ErrorPanel error={res.error} />;
    const names = new Map(accounts?.data?.items.map((a) => [a.id, a.name]) ?? []);
    found = res.data.items.length;
    rows = res.data.items.map((p) => ({
      id: p.id,
      number: p.number,
      status: p.status,
      travellers: p.travellers,
      account: names.get(p.accountId),
      planCode: p.planCode,
      dates: dayRange(p.coverageStart.slice(0, 10), p.coverageEnd.slice(0, 10)),
      destinations: p.state,
      premium: money(p.premiumTotal),
      matched: null,
    }));
  }

  const summary = searching
    ? `${rows.length} ${rows.length === 1 ? 'policy' : 'policies'} for “${q}”${status ? `, ${status}` : ''}.${
        found === LIMIT
          ? ` Only the first ${LIMIT} matches are searched; add detail to narrow them.`
          : ''
      }`
    : found === LIMIT
      ? `The ${LIMIT} newest. Search to find older ones.`
      : null;

  return (
    <>
      <PageHeader
        title="Policies"
        description="Find a policy by its number, a traveller, an account, a destination or a travel date."
        actions={
          me.permissions.includes('quotes:create') ? (
            <ButtonLink href="/quotes/new">
              <Calculator aria-hidden className="size-4" /> New quote
            </ButtonLink>
          ) : null
        }
      />
      <form method="get" role="search" aria-label="Find a policy" className="mb-4 flex gap-2">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-subtle"
          />
          <Input
            name="q"
            type="search"
            // A new search from elsewhere replaces what the box holds.
            key={q}
            defaultValue={q}
            minLength={2}
            maxLength={100}
            aria-label="Policy number, traveller, account, destination or travel date"
            placeholder="Number, name, account, country or date"
            className="h-12 pl-10 text-[15px]"
          />
        </div>
        <Button type="submit" className="h-12 px-5">
          Search
        </Button>
      </form>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-border px-3">
          <nav aria-label="Policy status" className="-mb-px flex max-w-full overflow-x-auto">
            {STATUSES.map((s) => (
              <Link
                key={s ?? 'all'}
                href={withQuery('/policies', {}, { q, status: s })}
                aria-current={s === status ? 'page' : undefined}
                className={clsx(
                  'shrink-0 border-b-2 px-3 py-3.5 text-sm font-medium focus-visible:outline-offset-[-3px]',
                  s === status
                    ? 'border-primary text-fg'
                    : 'border-transparent text-muted hover:border-border-strong hover:text-fg',
                )}
              >
                {s ? sentenceCase(s) : 'All'}
              </Link>
            ))}
          </nav>
          {q ? (
            <Link
              href={withQuery('/policies', {}, { status })}
              className="px-2 py-2 text-sm font-medium text-primary hover:underline"
            >
              Clear search
            </Link>
          ) : null}
        </div>
        {summary ? (
          <p role="status" className="border-b border-border px-4 py-2.5 text-sm text-muted">
            {summary}
          </p>
        ) : null}
        {q && !searching ? (
          <EmptyState
            icon={<Search className="size-5" />}
            title="Type a little more"
            description="A search needs at least two characters."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title={searching ? 'No policy found' : 'No policies yet'}
            description={
              searching
                ? 'Nothing you can see matches. Try fewer letters, another status or a different detail.'
                : status
                  ? `No policy is ${status}.`
                  : 'A policy is created when a quote is bought.'
            }
          />
        ) : (
          <Table caption="Policies">
            <THead>
              <tr>
                <TH>Policy</TH>
                <TH className="hidden lg:table-cell">Account</TH>
                <TH className="hidden md:table-cell">{searching ? 'Trip' : 'Cover'}</TH>
                <TH>Status</TH>
                {searching ? null : <TH className="hidden text-right sm:table-cell">Premium</TH>}
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link href={`/policies/${r.id}`} className="group block">
                      <span className="block font-semibold text-fg group-hover:text-primary group-hover:underline">
                        {r.travellers.join(', ') || r.number}
                      </span>
                      <span className="block text-xs text-muted">{r.number}</span>
                    </Link>
                    <span className="mt-1 block text-xs text-muted md:hidden">{r.dates}</span>
                    {r.matched ? (
                      <span className="mt-1 block text-xs text-subtle">Matched {r.matched}</span>
                    ) : null}
                  </TD>
                  <TD className="hidden lg:table-cell">
                    {r.account ?? <span className="text-muted">—</span>}
                    <span className="block text-xs text-muted">Plan {r.planCode}</span>
                  </TD>
                  <TD className="hidden md:table-cell">
                    <span className="whitespace-nowrap">{r.dates}</span>
                    <span className="block text-xs text-muted">
                      {searching ? r.destinations || '—' : `State ${r.destinations}`}
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={TONES[r.status]}>{sentenceCase(r.status)}</Badge>
                  </TD>
                  {searching ? null : (
                    <TD className="hidden text-right tabular-nums sm:table-cell">{r.premium}</TD>
                  )}
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
