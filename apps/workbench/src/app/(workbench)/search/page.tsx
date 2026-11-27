import Link from 'next/link';
import { Search } from 'lucide-react';
import type { SearchResult } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata = { title: 'Find a policy' };

const MATCH_LABELS = {
  number: 'Policy number',
  traveller: 'Traveller',
  account: 'Account',
  trip: 'Trip',
} as const;
const STATUS_TONES = { active: 'success', cancelled: 'neutral', expired: 'neutral' } as const;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('policies:read')) return <AccessDenied permission="policies:read" />;
  const q = ((await searchParams).q ?? '').trim().slice(0, 100);
  const res =
    q.length >= 2
      ? await load(() => api<SearchResult>('/v1/search', { query: { q, limit: 25 } }))
      : null;
  if (res?.error) return <ErrorPanel error={res.error} />;
  const result = res?.data ?? null;
  return (
    <>
      <PageHeader
        eyebrow="Policies"
        title="Find a policy"
        description="Search by part of a policy number, a traveller's name, an account's name or code, or a trip: a country code or region, or a departure or return date (YYYY-MM-DD). You see only the policies your access allows."
      />
      <Card className="mb-6">
        <form
          method="get"
          role="search"
          aria-label="Find a policy"
          className="flex flex-wrap items-end gap-3 p-4"
        >
          <label className="min-w-64 flex-1 text-sm">
            <span className="mb-1 block font-medium text-fg">
              Policy number, traveller, account or trip
            </span>
            <Input
              name="q"
              type="search"
              defaultValue={q}
              minLength={2}
              maxLength={100}
              required
              autoFocus
              placeholder="For example ATP-2026, Sam Sample, FR, 2026-12-15"
            />
          </label>
          <Button type="submit">
            <Search aria-hidden className="size-4" /> Search
          </Button>
        </form>
      </Card>
      {result ? (
        <Card>
          {result.items.length === 0 ? (
            <EmptyState
              icon={<Search className="size-5" />}
              title="No policy found"
              description={`Nothing you can see matches “${result.query}”. Try fewer letters, or a different kind of detail.`}
            />
          ) : (
            <>
              <p className="px-5 pt-4 text-sm text-muted" role="status">
                {result.items.length} {result.items.length === 1 ? 'policy' : 'policies'} for “
                {result.query}” in {result.tookMs} ms.
              </p>
              <Table caption="Policies found">
                <THead>
                  <tr>
                    <TH>Policy</TH>
                    <TH>Travellers</TH>
                    <TH>Account</TH>
                    <TH>Trip</TH>
                    <TH>Matched on</TH>
                  </tr>
                </THead>
                <tbody>
                  {result.items.map((h) => (
                    <TR key={h.policyId}>
                      <TD>
                        <Link
                          href={`/policies/${h.policyId}`}
                          className="font-mono text-xs font-medium text-fg hover:text-primary hover:underline"
                        >
                          {h.number}
                        </Link>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge tone={STATUS_TONES[h.status]}>{sentenceCase(h.status)}</Badge>
                          <span className="text-xs text-muted">{h.planCode}</span>
                        </div>
                      </TD>
                      <TD>{h.travellers.join(', ')}</TD>
                      <TD>{h.accountName}</TD>
                      <TD className="text-sm">
                        {h.destinations.join(', ') || '—'}
                        <p className="text-xs text-muted">
                          {h.departureDate ?? '—'} to {h.returnDate ?? '—'}
                        </p>
                      </TD>
                      <TD className="text-xs text-muted">
                        {h.matchedOn.map((m) => MATCH_LABELS[m]).join(', ')}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </Card>
      ) : null}
    </>
  );
}
