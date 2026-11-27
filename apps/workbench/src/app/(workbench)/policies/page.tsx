import Link from 'next/link';
import { FileText, Search } from 'lucide-react';
import type { z } from 'zod';
import type { PolicySummarySchema } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata = { title: 'Policies' };

type Summary = z.infer<typeof PolicySummarySchema>;
const TONES = { active: 'success', cancelled: 'neutral', expired: 'neutral' } as const;

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('policies:read')) return <AccessDenied permission="policies:read" />;
  const { q, status } = await searchParams;
  const qs = new URLSearchParams({ limit: '50' });
  if (q) qs.set('q', q);
  if (status && ['active', 'cancelled', 'expired'].includes(status)) qs.set('status', status);
  const res = await load(() => api<{ items: Summary[] }>(`/v1/policies?${qs}`));
  if (res.error) return <ErrorPanel error={res.error} />;
  const items = res.data.items;
  return (
    <>
      <PageHeader
        eyebrow="Policies"
        title="Policies"
        description="One record per policy: plan, travellers, trip, benefits, premiums, components and history. Search by policy number or traveller name."
      />
      <form
        method="get"
        className="mb-6 flex flex-wrap items-end gap-3"
        role="search"
        aria-label="Search policies"
      >
        <label className="space-y-1.5 text-sm font-medium text-fg">
          Policy number or traveller
          <input
            name="q"
            defaultValue={q ?? ''}
            className="block h-10 w-72 rounded-lg border border-border-strong bg-surface px-3 text-sm"
          />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-fg">
          Status
          <select
            name="status"
            defaultValue={status ?? ''}
            className="block h-10 rounded-lg border border-border-strong bg-surface px-3 text-sm"
          >
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </select>
        </label>
        <button className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-contrast shadow-card hover:bg-primary-hover">
          <Search aria-hidden className="size-4" /> Search
        </button>
      </form>
      <Card>
        {items.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title="No policies found"
            description={
              q || status ? 'Try a different search.' : 'A policy is created when a quote is bound.'
            }
          />
        ) : (
          <Table caption="Policies">
            <THead>
              <tr>
                <TH>Policy</TH>
                <TH>Travellers</TH>
                <TH>Plan</TH>
                <TH>Status</TH>
                <TH>Cover</TH>
                <TH className="text-right">Premium</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <Link
                      href={`/policies/${p.id}`}
                      className="font-mono text-xs font-medium text-fg hover:text-primary hover:underline"
                    >
                      {p.number}
                    </Link>
                  </TD>
                  <TD>{p.travellers.join(', ')}</TD>
                  <TD>
                    {p.planCode} · {p.state}
                  </TD>
                  <TD>
                    <Badge tone={TONES[p.status]}>{sentenceCase(p.status)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-muted">
                    {p.coverageStart.slice(0, 10)} to {p.coverageEnd.slice(0, 10)}
                  </TD>
                  <TD className="text-right font-mono text-xs">{p.premiumTotal}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
