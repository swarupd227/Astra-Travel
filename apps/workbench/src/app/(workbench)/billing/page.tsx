import Link from 'next/link';
import { Receipt } from 'lucide-react';
import type { z } from 'zod';
import type { PremiumRecordSummarySchema } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, EmptyState, Notice, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { RECORD_TONES } from './tones';

export const metadata = { title: 'Premium records' };

type Item = z.infer<typeof PremiumRecordSummarySchema>;
const STATUSES = ['', 'held', 'ready', 'batched', 'sent', 'confirmed', 'rejected'] as const;
const money = (v: string) =>
  `${v.startsWith('-') ? '−' : ''}$${Number(v.replace('-', '')).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; batch?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('billing:read')) return <AccessDenied permission="billing:read" />;
  const { status, batch } = await searchParams;
  const batchId = batch && /^[0-9a-f-]{36}$/i.test(batch) ? batch : '';
  const filter = STATUSES.includes((status ?? '') as (typeof STATUSES)[number])
    ? (status ?? '')
    : '';
  const [res, held] = await Promise.all([
    load(() =>
      api<{ items: Item[] }>(
        `/v1/premium-records?limit=100${filter ? `&status=${filter}` : ''}${batchId ? `&batchId=${batchId}` : ''}`,
      ),
    ),
    load(() => api<{ items: Item[] }>('/v1/premium-records?status=held&limit=1')),
  ]);
  if (res.error) return <ErrorPanel error={res.error} />;
  const items = res.data.items;
  return (
    <>
      <PageHeader
        title="Premium records"
        description="Every charge and refund, with commission and tax, on its way to Assurant’s billing system."
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/billing/batches" variant="secondary">
              <Receipt aria-hidden className="size-4" /> Batches
            </ButtonLink>
            <ButtonLink href="/billing/rules" variant="secondary">
              Commission and programme rules
            </ButtonLink>
          </div>
        }
      />
      {held.data?.items.length && filter !== 'held' ? (
        <div className="mb-6">
          <Notice tone="warning" title="Some records are held">
            A held record is missing a tax rate, a commission rule or an underwriting arrangement
            and is not sent until it is fixed.{' '}
            <Link href="/billing?status=held" className="font-medium text-primary hover:underline">
              Show held records
            </Link>
          </Notice>
        </div>
      ) : null}
      {batchId ? (
        <div className="mb-4">
          <Notice tone="primary" title="One batch">
            Showing the records of one batch.{' '}
            <Link href="/billing" className="font-medium text-primary hover:underline">
              Show all records
            </Link>
          </Notice>
        </div>
      ) : null}
      <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <Link
            key={s || 'all'}
            href={s ? `/billing?status=${s}` : '/billing'}
            aria-current={filter === s ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${filter === s ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-fg'}`}
          >
            {s ? sentenceCase(s) : 'All'}
          </Link>
        ))}
      </nav>
      <Card>
        {items.length === 0 ? (
          <EmptyState
            icon={<Receipt className="size-5" />}
            title="No premium records"
            description="A record is written with every bind, change and cancellation."
          />
        ) : (
          <Table caption="Premium records">
            <THead>
              <tr>
                <TH>Record</TH>
                <TH>Policy</TH>
                <TH>Type</TH>
                <TH className="text-right">Premium</TH>
                <TH className="text-right">Commission</TH>
                <TH className="text-right">Tax</TH>
                <TH>Status</TH>
                <TH>When</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link
                      href={`/billing/records/${r.id}`}
                      className="font-mono text-xs font-medium text-fg hover:text-primary hover:underline"
                    >
                      {r.number}
                    </Link>
                  </TD>
                  <TD>
                    {r.policyNumber ? (
                      <Link
                        href={`/policies/${r.policyId}`}
                        className="hover:text-primary hover:underline"
                      >
                        {r.policyNumber}
                      </Link>
                    ) : r.period ? (
                      `Programme, ${r.period}`
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD>{sentenceCase(r.type)}</TD>
                  <TD className="text-right font-mono text-xs">{money(r.premium)}</TD>
                  <TD className="text-right font-mono text-xs">
                    {r.commission ? money(r.commission.amount) : '—'}
                  </TD>
                  <TD className="text-right font-mono text-xs">{r.tax ? money(r.tax) : '—'}</TD>
                  <TD>
                    <Badge tone={RECORD_TONES[r.status]}>{sentenceCase(r.status)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted">
                    <LocalTime iso={r.occurredAt} />
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
