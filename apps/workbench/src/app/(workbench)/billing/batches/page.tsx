import Link from 'next/link';
import { ChevronLeft, Download, Layers } from 'lucide-react';
import type { Batch } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { buttonClass } from '@/components/ui/button';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { CreateBatchForm, RetryBatchForm } from '../billing-forms';
import { BATCH_TONES } from '../tones';

export const metadata = { title: 'Billing batches' };

const money = (v: string) =>
  `${v.startsWith('-') ? '−' : ''}$${Number(v.replace('-', '')).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function BatchesPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('billing:read')) return <AccessDenied permission="billing:read" />;
  const res = await load(() => api<{ items: Batch[] }>('/v1/billing/batches?limit=50'));
  if (res.error) return <ErrorPanel error={res.error} />;
  const items = res.data.items;
  const attention = items.filter((b) => ['mismatch', 'unconfirmed', 'rejected'].includes(b.status));
  const canManage = me.permissions.includes('billing:manage');
  return (
    <>
      <Link
        href="/billing"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Premium records
      </Link>
      <PageHeader
        eyebrow="Billing"
        title="Batches sent to billing"
        description="Each batch takes every ready record once and carries its record count and amount totals. Billing confirms the totals it received; a difference, or no answer, is raised here."
        actions={canManage ? <CreateBatchForm /> : null}
      />
      {attention.length ? (
        <div className="mb-6">
          <Notice
            tone="danger"
            title={`${attention.length} batch${attention.length === 1 ? '' : 'es'} need attention`}
          >
            A batch whose totals billing did not agree with, that billing did not confirm, or that
            billing rejected records of, is marked below with its reason.
          </Notice>
        </div>
      ) : null}
      <Card>
        <CardHeader title="Batches" description="Newest first." />
        {items.length === 0 ? (
          <EmptyState
            icon={<Layers className="size-5" />}
            title="No batches yet"
            description="Collect the ready records into a batch to send them."
          />
        ) : (
          <Table caption="Billing batches">
            <THead>
              <tr>
                <TH>Batch</TH>
                <TH>Status</TH>
                <TH className="text-right">Records</TH>
                <TH className="text-right">Premium</TH>
                <TH className="text-right">Commission</TH>
                <TH className="text-right">Tax</TH>
                <TH>Sent</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {items.map((b) => (
                <TR key={b.id}>
                  <TD>
                    <Link
                      href={`/billing?batch=${b.id}`}
                      className="font-mono text-xs font-medium text-fg"
                    >
                      #{b.number}
                    </Link>
                    <span className="block text-xs text-muted">
                      {b.sha256.slice(0, 10) || 'writing…'}
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={BATCH_TONES[b.status]}>{sentenceCase(b.status)}</Badge>
                    {b.lastError ? (
                      <span className="mt-1 block max-w-xs text-xs text-danger">{b.lastError}</span>
                    ) : null}
                    {b.status === 'sent' ? (
                      <span className="block text-xs text-muted">
                        Waiting for billing, send {b.attempts}
                      </span>
                    ) : null}
                  </TD>
                  <TD className="text-right">{b.totals.count}</TD>
                  <TD className="text-right font-mono text-xs">{money(b.totals.premium)}</TD>
                  <TD className="text-right font-mono text-xs">{money(b.totals.commission)}</TD>
                  <TD className="text-right font-mono text-xs">{money(b.totals.tax)}</TD>
                  <TD className="whitespace-nowrap text-muted">
                    {b.sentAt ? <LocalTime iso={b.sentAt} /> : '—'}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`/api/billing/batches/${b.id}/file`}
                        className={buttonClass('ghost', 'sm')}
                        aria-label={`Download the file of batch ${b.number}`}
                      >
                        <Download aria-hidden className="size-3.5" /> File
                      </a>
                      {canManage && ['unconfirmed', 'mismatch'].includes(b.status) ? (
                        <RetryBatchForm batchId={b.id} />
                      ) : null}
                    </div>
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
