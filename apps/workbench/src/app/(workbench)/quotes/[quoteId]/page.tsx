import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { CircleAlert, CircleCheck, MonitorSmartphone } from 'lucide-react';
import clsx from 'clsx';
import type { Quote } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { dayRange, formatDay, money, sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { BackLink } from '@/components/ui/back-link';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, CardHeader, Notice } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { EvaluationView } from '../../underwriting/uw-forms';
import { SelectionForm } from '../quote-forms';
import { IssueButton } from './issue-button';

export const metadata = { title: 'Quote' };

const OUTCOME = {
  eligible: 'success',
  ineligible: 'danger',
  referred: 'warning',
  held: 'warning',
} as const;
const STATUS = { open: 'Open', bound: 'Bought', expired: 'Expired' } as const;

export default async function QuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ quoteId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('quotes:read')) return <AccessDenied permission="quotes:read" />;
  const { quoteId } = await params;
  const { created } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) notFound();
  const res = await load(() => api<Quote>(`/v1/quotes/${quoteId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const q = res.data;
  const canCreate = me.permissions.includes('quotes:create');
  const canEdit = canCreate && q.status === 'open';
  const travellerName = (id: string) => {
    const t = q.travellers.find((x) => x.id === id);
    return t ? `${t.firstName} ${t.lastName}` : id;
  };
  const benefitName = (code: string) => q.benefits.find((b) => b.code === code)?.name ?? code;
  const Verdict = q.bindable ? CircleCheck : CircleAlert;

  return (
    <>
      <BackLink href="/quotes">Quotes</BackLink>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
              {q.premium ? `${money(q.premium.total)} total` : 'Quote'}
            </h1>
            <Badge tone={OUTCOME[q.outcome]} className="px-2.5 py-1">
              {sentenceCase(q.outcome)}
            </Badge>
            <Badge tone={q.status === 'open' ? 'primary' : 'neutral'} className="px-2.5 py-1">
              {STATUS[q.status]}
            </Badge>
          </div>
          <p className="mt-1.5 text-sm text-muted">
            <span className="font-medium text-fg">
              {q.travellers.map((t) => `${t.firstName} ${t.lastName}`).join(', ')}
            </span>{' '}
            · {q.plan.code} · {q.state} · open until {formatDay(q.expiresAt.slice(0, 10))}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCreate ? (
            <ButtonLink href={`/quotes/${q.id}/widget`}>
              <MonitorSmartphone aria-hidden className="size-4" /> Widget preview
            </ButtonLink>
          ) : null}
          {q.bindable && canEdit ? <IssueButton quote={q} keyId={randomUUID()} /> : null}
        </div>
      </header>

      <div className="mb-6 space-y-3">
        {created ? (
          <Notice tone="success" title="Quote made">
            Change the optional benefits to re-price it; the quote keeps its number.
          </Notice>
        ) : null}
        {q.premium && q.premium.kind !== 'premium' ? (
          <Notice
            tone="warning"
            title={
              q.premium.kind === 'loss_cost'
                ? 'Loss cost, not a premium'
                : 'Mixed loss costs and premiums'
            }
          >
            No loss cost multiplier is filed for the rates, so these amounts are loss costs. They
            are shown for information and cannot be charged.
          </Notice>
        ) : null}
        <div
          role="status"
          className={clsx(
            'flex gap-3 rounded-xl border px-4 py-3 text-sm',
            q.bindable ? 'border-success/30 bg-success-soft' : 'border-warning/30 bg-warning-soft',
          )}
        >
          <Verdict
            aria-hidden
            className={clsx('mt-0.5 size-5 shrink-0', q.bindable ? 'text-success' : 'text-warning')}
          />
          <div className="min-w-0 text-fg">
            {q.bindable ? (
              <>
                <p className="font-semibold">Ready to bind</p>
                <p className="text-muted">
                  It can be bought once the traveller acknowledges the disclosure and the payment is
                  confirmed.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold">Cannot be bought as it stands</p>
                <ul className="list-disc pl-5 text-muted">
                  {q.notBindable.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          <Card aria-labelledby="benefits">
            <CardHeader
              titleId="benefits"
              title="Benefits and cover dates"
              description="Cover dates are those that apply if it is bought today."
            />
            <ul className="divide-y divide-border">
              {q.benefits.map((b) => (
                <li
                  key={b.code}
                  className={clsx(
                    'flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3.5',
                    !b.selected && 'bg-surface-muted/40',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-fg">
                      {b.name}{' '}
                      <span className="font-normal text-muted">
                        · {sentenceCase(b.packaging).toLowerCase()}
                      </span>
                    </p>
                    <p className="text-sm text-muted">
                      {b.selected
                        ? dayRange(b.coverageStart?.slice(0, 10), b.coverageEnd?.slice(0, 10))
                        : 'Not included'}
                    </p>
                  </div>
                  <p className="text-sm font-medium tabular-nums text-fg">
                    {b.selected && b.premium ? money(b.premium) : '—'}
                  </p>
                </li>
              ))}
            </ul>
            {q.premium ? (
              <>
                <p className="flex justify-between gap-4 border-t-2 border-border-strong px-5 py-3.5 text-sm font-semibold text-fg">
                  <span>Total</span>
                  <span className="tabular-nums">{money(q.premium.total)}</span>
                </p>
                <details className="border-t border-border">
                  <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-primary">
                    Price by traveller and worksheet
                  </summary>
                  <Table caption="Premium by benefit and traveller">
                    <THead>
                      <tr>
                        <TH>Benefit</TH>
                        <TH>Traveller</TH>
                        <TH>Worksheet</TH>
                        <TH className="text-right">Amount</TH>
                      </tr>
                    </THead>
                    <tbody>
                      {q.premium.lines.map((l) => (
                        <TR key={l.worksheetId}>
                          <TD>{benefitName(l.benefit)}</TD>
                          <TD>{travellerName(l.travellerId)}</TD>
                          <TD className="font-mono text-xs text-muted">
                            {l.worksheetId.slice(0, 8)}
                          </TD>
                          <TD className="text-right tabular-nums">{money(l.amount)}</TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                  {q.premium.basis ? (
                    <p className="px-5 py-3 text-xs text-muted">
                      Basis: {q.premium.basis.amount} {q.premium.basis.unit}
                    </p>
                  ) : null}
                </details>
              </>
            ) : (
              <p className="border-t border-border px-5 py-4 text-sm text-muted">Not priced.</p>
            )}
          </Card>

          <Card aria-labelledby="eligibility">
            <CardHeader
              titleId="eligibility"
              title="Eligibility"
              description="Decided by the plan’s published rules."
            />
            <div className="p-5">
              <EvaluationView r={q.evaluation} />
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {canEdit ? (
            <Card aria-labelledby="optional">
              <CardHeader
                titleId="optional"
                title="Optional benefits"
                description="Tick the ones to include, then re-rate."
              />
              <div className="p-5">
                <SelectionForm quote={q} />
              </div>
            </Card>
          ) : null}
          <Card aria-labelledby="disclosure">
            <CardHeader titleId="disclosure" title="State disclosure" />
            <div className="space-y-2 p-5 text-sm">
              {q.disclosure ? (
                <>
                  <p className="font-medium text-fg">{q.disclosure.title}</p>
                  <p className="whitespace-pre-line text-muted">{q.disclosure.text}</p>
                  <p className="text-xs text-subtle">Version {q.disclosure.version}</p>
                </>
              ) : (
                <p className="text-muted">No disclosure is in force for {q.state}.</p>
              )}
            </div>
          </Card>
          <Card aria-labelledby="versions">
            <CardHeader titleId="versions" title="Versions used" />
            <dl className="space-y-3 px-5 py-4 text-sm">
              {[
                { term: 'Plan', value: `${q.plan.code}, version ${q.plan.version}` },
                { term: 'Rule set', value: `Version ${q.ruleSet.version}` },
                ...Object.entries(q.manuals).map(([b, m]) => ({
                  term: `${benefitName(b)} rates`,
                  value: `${m.code}, version ${m.version}`,
                })),
                { term: 'Made', value: <LocalTime iso={q.createdAt} /> },
                { term: 'Quote reference', value: q.id.slice(0, 8).toUpperCase() },
              ].map((i) => (
                <div key={i.term} className="flex justify-between gap-4">
                  <dt className="text-muted">{i.term}</dt>
                  <dd className="min-w-0 text-right text-fg">{i.value}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
