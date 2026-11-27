import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Download } from 'lucide-react';
import type { PremiumRecord } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import {
  Badge,
  Card,
  CardHeader,
  DescriptionList,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { RecalculateForm } from '../../billing-forms';
import { RECORD_TONES } from '../../tones';

export const metadata = { title: 'Premium record' };

const money = (v: string) =>
  `${v.startsWith('-') ? '−' : ''}$${Number(v.replace('-', '')).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function RecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<{ recalculated?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('billing:read')) return <AccessDenied permission="billing:read" />;
  const { recordId } = await params;
  const { recalculated } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(recordId)) notFound();
  const res = await load(() => api<PremiumRecord>(`/v1/premium-records/${recordId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const r = res.data;
  return (
    <>
      <Link
        href="/billing"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Premium records
      </Link>
      <PageHeader
        eyebrow={r.policyNumber ?? 'Card programme'}
        title={r.number}
        description={`${sentenceCase(r.type)}${r.period ? ` for ${r.period}` : ''}. ${Number(r.premium) < 0 ? 'A refund' : 'A charge'} of ${money(r.premium)}.`}
        actions={
          <>
            {me.permissions.includes('audit:read') ? (
              <a href={`/api/trace/premium-records/${r.id}`} className={buttonClass('secondary')}>
                <Download aria-hidden className="size-4" /> Audit trace
              </a>
            ) : null}
            <Badge tone={RECORD_TONES[r.status]}>{sentenceCase(r.status)}</Badge>
          </>
        }
      />
      {recalculated ? (
        <div className="mb-6">
          <Notice tone="success" title="Recalculated">
            The record was worked out again with what is configured now.
          </Notice>
        </div>
      ) : null}
      {r.status === 'held' ? (
        <div className="mb-6">
          <Notice tone="warning" title="Held: not sent to billing until this is fixed">
            <ul className="list-disc pl-5">
              {r.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
            {me.permissions.includes('billing:manage') ? (
              <div className="mt-3">
                <RecalculateForm recordId={r.id} />
              </div>
            ) : null}
          </Notice>
        </div>
      ) : null}
      {r.status === 'rejected' ? (
        <div className="mb-6">
          <Notice tone="danger" title="Rejected by billing">
            {r.billingReason ?? 'No reason was given.'}
          </Notice>
        </div>
      ) : null}

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Amounts" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'Premium', value: <span className="font-mono">{money(r.premium)}</span> },
                { term: 'Charged', value: <span className="font-mono">{money(r.charge)}</span> },
                { term: 'Refunded', value: <span className="font-mono">{money(r.refund)}</span> },
                {
                  term: 'Kept by the plan’s rule',
                  value: <span className="font-mono">{money(r.retained)}</span>,
                },
                {
                  term: 'Commission',
                  value: r.commission ? (
                    <span className="font-mono">
                      {money(r.commission.amount)} ({r.commission.rule})
                    </span>
                  ) : (
                    '—'
                  ),
                },
                {
                  term: 'Premium tax',
                  value: r.tax ? <span className="font-mono">{money(r.tax)}</span> : '—',
                },
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Record" />
          <div className="p-5">
            <DescriptionList
              items={[
                {
                  term: 'Policy',
                  value: r.policyId ? (
                    <Link className="text-primary hover:underline" href={`/policies/${r.policyId}`}>
                      {r.policyNumber}
                    </Link>
                  ) : (
                    '—'
                  ),
                },
                { term: 'State', value: r.state ?? '—' },
                { term: 'When', value: <LocalTime iso={r.occurredAt} /> },
                {
                  term: 'Batch',
                  value: r.batchId ? (
                    <Link className="text-primary hover:underline" href="/billing/batches">
                      Open batches
                    </Link>
                  ) : (
                    'Not yet batched'
                  ),
                },
                { term: 'Billing reference', value: r.billingReference ?? '—' },
                {
                  term: 'Rating worksheets',
                  value: r.worksheetIds.length ? (
                    <span className="font-mono text-xs">{r.worksheetIds.length} linked</span>
                  ) : (
                    '—'
                  ),
                },
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Billing basis"
            description="The account’s agreed basis and its calculation, as the quote stored them."
          />
          <div className="p-5">
            {r.basis ? (
              <dl className="space-y-1 text-sm">
                {Object.entries(r.basis).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-muted">{sentenceCase(k.replace(/([A-Z])/g, ' $1'))}</dt>
                    <dd className="font-mono text-xs">
                      {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted">No basis is stored for this record.</p>
            )}
          </div>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader
          title="By underwriting entity"
          description="Each benefit’s premium goes to the company named in the plan; the entities always add up to the premium."
        />
        <Table caption="Allocation by entity">
          <THead>
            <tr>
              <TH>Entity</TH>
              <TH>Arrangement</TH>
              <TH className="text-right">Premium</TH>
              <TH className="text-right">Tax rate</TH>
              <TH className="text-right">Tax</TH>
            </tr>
          </THead>
          <tbody>
            {r.allocation.map((a, i) => (
              <TR key={i}>
                <TD>{a.entity}</TD>
                <TD>{a.arrangement ?? '—'}</TD>
                <TD className="text-right font-mono text-xs">{money(a.premium)}</TD>
                <TD className="text-right font-mono text-xs">
                  {a.taxRatePercent === null ? '—' : `${a.taxRatePercent}%`}
                </TD>
                <TD className="text-right font-mono text-xs">
                  {a.tax === null ? '—' : money(a.tax)}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="By benefit" />
          <Table caption="Premium by benefit">
            <THead>
              <tr>
                <TH>Benefit</TH>
                <TH className="text-right">Premium</TH>
              </tr>
            </THead>
            <tbody>
              {r.perBenefit.map((b) => (
                <TR key={b.code}>
                  <TD>{sentenceCase(b.code.replace(/_/g, ' '))}</TD>
                  <TD className="text-right font-mono text-xs">{money(b.premium)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="By traveller" />
          <Table caption="Premium by traveller">
            <THead>
              <tr>
                <TH>Traveller</TH>
                <TH className="text-right">Premium</TH>
              </tr>
            </THead>
            <tbody>
              {r.perTraveller.map((t) => (
                <TR key={t.travellerId}>
                  <TD>{t.travellerId}</TD>
                  <TD className="text-right font-mono text-xs">{money(t.premium)}</TD>
                </TR>
              ))}
              {r.perTraveller.length === 0 ? (
                <TR>
                  <TD colSpan={2} className="text-muted">
                    Not split by traveller.
                  </TD>
                </TR>
              ) : null}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
