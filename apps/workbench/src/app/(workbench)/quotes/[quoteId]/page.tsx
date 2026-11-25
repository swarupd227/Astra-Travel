import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { Quote } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, DescriptionList, Notice, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { EvaluationView } from '../../underwriting/uw-forms';
import { randomUUID } from 'node:crypto';
import { IssueForm, SelectionForm } from '../quote-forms';

export const metadata = { title: 'Quote' };

const OUTCOME = { eligible: 'success', ineligible: 'danger', referred: 'warning', held: 'warning' } as const;
const when = (s: string | null) => (s ? s.replace('T', ' ') : '—');

export default async function QuotePage({ params, searchParams }: { params: Promise<{ quoteId: string }>; searchParams: Promise<{ created?: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('quotes:read')) return <AccessDenied permission="quotes:read" />;
  const { quoteId } = await params;
  const { created } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) notFound();
  const res = await load(() => api<Quote>(`/v1/quotes/${quoteId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const q = res.data;
  const canEdit = me.permissions.includes('quotes:create') && q.status === 'open';
  return (
    <>
      <Link href="/quotes" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg">
        <ChevronLeft aria-hidden className="size-4" /> Quotes
      </Link>
      <PageHeader
        eyebrow={`${q.plan.code} · ${q.state}`}
        title={q.premium ? `${q.premium.total} total` : 'Quote'}
        description={`Quote ${q.id}, revision ${q.revision}. Open until ${q.expiresAt.slice(0, 10)}.`}
        actions={
          <>
            <Badge tone={OUTCOME[q.outcome]}>{sentenceCase(q.outcome)}</Badge>
            <Badge tone={q.status === 'open' ? 'primary' : 'neutral'}>{sentenceCase(q.status)}</Badge>
          </>
        }
      />
      <div className="mb-6 space-y-3">
        {created ? (
          <Notice tone="success" title="Quote made">
            Change the optional benefits below to re-rate it; the quote keeps its number.
          </Notice>
        ) : null}
        {q.premium && q.premium.kind !== 'premium' ? (
          <Notice tone="warning" title={q.premium.kind === 'loss_cost' ? 'Loss cost, not a premium' : 'Mixed loss costs and premiums'}>
            No loss cost multiplier is filed for the rate manual, so these amounts are loss costs. They are shown for information and cannot be charged or bound.
          </Notice>
        ) : null}
        {q.bindable ? (
          <Notice tone="success" title="Ready to bind">
            It can be bound through the API once the payment system confirms the premium and the traveller has acknowledged the disclosure below.
          </Notice>
        ) : (
          <Notice tone="warning" title="Cannot be bound as it stands">
            <ul className="list-disc pl-5">
              {q.notBindable.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Notice>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {q.bindable && canEdit ? (
            <Card>
              <CardHeader title="Issue the policy" description="For a traveller or account that cannot do it themselves, such as by phone. Uses the same rules and rating as the API." />
              <div className="p-5">
                <IssueForm quote={q} keyId={randomUUID()} />
              </div>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Price" description="Per benefit, per traveller and in total, with the worksheet behind every line." />
            {q.premium ? (
              <>
                <Table caption="Premium by benefit and traveller">
                  <THead>
                    <tr>
                      <TH>Benefit</TH>
                      <TH>Traveller</TH>
                      <TH className="text-right">Amount</TH>
                      <TH>Worksheet</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {q.premium.lines.map((l) => (
                      <TR key={l.worksheetId}>
                        <TD className="font-mono text-xs">{l.benefit}</TD>
                        <TD>{q.travellers.find((t) => t.id === l.travellerId)?.firstName ?? l.travellerId}</TD>
                        <TD className="text-right font-mono text-xs">{l.amount}</TD>
                        <TD className="font-mono text-xs text-muted">{l.worksheetId.slice(0, 8)}</TD>
                      </TR>
                    ))}
                    <TR>
                      <TD colSpan={2} className="font-medium">
                        Total
                      </TD>
                      <TD className="text-right font-mono text-xs font-semibold">{q.premium.total}</TD>
                      <TD>{q.premium.basis ? <span className="text-xs text-muted">{q.premium.basis.amount} {q.premium.basis.unit}</span> : null}</TD>
                    </TR>
                  </tbody>
                </Table>
              </>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">Not priced.</p>
            )}
          </Card>

          <Card>
            <CardHeader title="Benefits and cover dates" description="Packaged benefits are always included. Cover dates are those the plan’s timing gives if bound today." />
            <Table caption="Benefits">
              <THead>
                <tr>
                  <TH>Benefit</TH>
                  <TH>Sold as</TH>
                  <TH>Cover starts</TH>
                  <TH>Cover ends</TH>
                </tr>
              </THead>
              <tbody>
                {q.benefits.map((b) => (
                  <TR key={b.code}>
                    <TD>
                      {b.name}
                      {!b.selected ? <span className="ml-2 text-xs text-muted">not included</span> : null}
                    </TD>
                    <TD>{sentenceCase(b.packaging)}</TD>
                    <TD className="whitespace-nowrap text-xs">{when(b.coverageStart)}</TD>
                    <TD className="whitespace-nowrap text-xs">{when(b.coverageEnd)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader title="Eligibility" description="From the plan’s published rule set." />
            <div className="p-5">
              <EvaluationView r={q.evaluation} />
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          {canEdit ? (
            <Card>
              <CardHeader title="Optional benefits" description="Tick the ones to include and re-rate." />
              <div className="p-5">
                <SelectionForm quote={q} />
              </div>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Versions used" />
            <div className="p-5">
              <DescriptionList
                items={[
                  { term: 'Plan', value: `${q.plan.code} version ${q.plan.version}` },
                  { term: 'Rule set', value: `Version ${q.ruleSet.version}` },
                  ...Object.entries(q.manuals).map(([b, m]) => ({ term: `${b} manual`, value: `${m.code} version ${m.version}` })),
                  { term: 'Made', value: <LocalTime iso={q.createdAt} /> },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="State disclosure" />
            <div className="space-y-2 p-5 text-sm">
              {q.disclosure ? (
                <>
                  <p className="font-medium text-fg">{q.disclosure.title}</p>
                  <p className="text-muted">{q.disclosure.text}</p>
                  <p className="font-mono text-xs text-muted">Version {q.disclosure.version}</p>
                </>
              ) : (
                <p className="text-muted">No disclosure is in force for {q.state}.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
