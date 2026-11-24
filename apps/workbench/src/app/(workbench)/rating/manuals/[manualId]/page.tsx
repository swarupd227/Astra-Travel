import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ChevronLeft, CircleDashed } from 'lucide-react';
import { RATING_INPUT_LABELS, type ParityRun, type RateManual } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import {
  Badge,
  Card,
  CardHeader,
  DescriptionList,
  EmptyState,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { ApproveManualForm, ParityForms, PublishManualForm } from '../../rating-forms';
import { AgentProposals } from '../../../proposals/agent-proposals';

export const metadata = { title: 'Rate manual' };

type Readiness = { ready: boolean; checks: { check: string; passed: boolean; detail: string }[] };
const CHECK_LABELS: Record<string, string> = {
  not_illustrative: 'Filed values, not estimated loadings',
  approved: 'Approved by a second rating analyst',
  filed: 'Approved filing in effect in the state',
  parity: 'Every parity case matches to the cent',
};

export default async function ManualPage({
  params,
  searchParams,
}: {
  params: Promise<{ manualId: string }>;
  searchParams: Promise<{ loaded?: string; done?: string; asked?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('rating:read')) return <AccessDenied permission="rating:read" />;
  const { manualId } = await params;
  const { loaded, done, asked } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(manualId)) notFound();
  const [manual, readiness, cases, run] = await Promise.all([
    load(() => api<RateManual>(`/v1/rate-manuals/${manualId}`)),
    load(() => api<Readiness>(`/v1/rate-manuals/${manualId}/readiness`)),
    load(() =>
      api<{
        items: {
          id: string;
          name: string;
          source: string;
          expectedAmount: string;
          factors: number;
        }[];
      }>(`/v1/rate-manuals/${manualId}/parity-cases`),
    ),
    load(() => api<ParityRun>(`/v1/rate-manuals/${manualId}/parity-runs/latest`)),
  ]);
  if (manual.error instanceof ApiProblem && manual.error.problem.code === 'not_found') notFound();
  if (manual.error) return <ErrorPanel error={manual.error} />;
  const m = manual.data;
  const d = m.document;
  const names = await peopleNames([m.createdBy, m.approvedBy, m.publishedBy]);
  const canApprove = me.permissions.includes('rating:approve');

  return (
    <>
      <Link
        href="/rating/manuals"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Rate manuals
      </Link>
      <PageHeader
        eyebrow={`${m.state} · ${m.benefit}`}
        title={`${m.code}, version ${m.version}`}
        description={`Effective from ${m.effectiveFrom}${m.effectiveTo ? ` to ${m.effectiveTo}` : ''}. Source: ${m.source}`}
        actions={
          <>
            {m.illustrative ? <Badge tone="danger">Illustrative</Badge> : null}
            <Badge tone={m.status === 'published' ? 'success' : 'primary'}>
              {sentenceCase(m.status)}
            </Badge>
          </>
        }
      />
      <div className="mb-6 space-y-3">
        {loaded ? (
          <Notice tone="success" title="Manual loaded">
            It is a draft. A second rating analyst checks the tables against the manual pages and
            approves it.
          </Notice>
        ) : null}
        {done ? (
          <Notice tone="success" title={`Manual ${done}`}>
            {done === 'published'
              ? 'It is used for rating from its effective date.'
              : 'It can be published once it is filed and passes parity.'}
          </Notice>
        ) : null}
        {d.conversion.lossCostMultiplier === null ? (
          <Notice tone="warning" title="No loss cost multiplier">
            Results from this manual are loss costs, not premiums, until Assurant provides the
            multiplier.
          </Notice>
        ) : null}
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Ready to publish?" />
          <div className="space-y-4 p-5">
            {readiness.data ? (
              <ul className="space-y-3">
                {readiness.data.checks.map((c) => (
                  <li key={c.check} className="flex gap-2 text-sm">
                    {c.passed ? (
                      <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : (
                      <CircleDashed aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                    )}
                    <span>
                      <span className="font-medium text-fg">{CHECK_LABELS[c.check]}</span>
                      <span className="sr-only">{c.passed ? ': done' : ': not yet'}</span>
                      <span className="block text-muted">{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {m.status === 'draft' && canApprove ? (
              m.createdBy === me.subject ? (
                <Notice tone="neutral">
                  You loaded this manual, so another rating analyst must approve it.
                </Notice>
              ) : (
                <ApproveManualForm manualId={m.id} />
              )
            ) : null}
            {m.status === 'approved' && canApprove ? (
              <PublishManualForm manualId={m.id} ready={!!readiness.data?.ready} />
            ) : null}
            <DescriptionList
              items={[
                { term: 'Loaded by', value: nameOf(names, m.createdBy) },
                { term: 'Loaded', value: <LocalTime iso={m.createdAt} /> },
                { term: 'Approved by', value: nameOf(names, m.approvedBy) },
                { term: 'Published by', value: nameOf(names, m.publishedBy) },
              ]}
            />
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Formula" />
          <div className="space-y-2 p-5 text-sm">
            <p className="font-mono text-xs text-fg">
              rate = {d.baseLossCost} &times; (trip cost / 100 &times; table {d.exposure.table})
              &times; {d.variables.map((v) => v.label).join(' × ') || 'no variables'}
              {d.perilPackage ? ` × peril package (${d.perilPackage.table})` : ''}
              {d.exclusionWaivers
                ? ` × removal of exclusions (max ${d.exclusionWaivers.maxCombined})`
                : ''}
              {d.supplemental.length ? ' + supplemental benefits' : ''}
            </p>
            {d.minimumTripCost ? (
              <p className="text-muted">
                Trip costs from {d.minimumTripCost.from} to {d.minimumTripCost.to} rate as{' '}
                {d.minimumTripCost.ratesAs}.
              </p>
            ) : null}
            <p className="text-muted">
              Loss cost multiplier: {d.conversion.lossCostMultiplier ?? 'not filed'} · minimum
              premium: {d.conversion.minimumPremium ?? 'none'} · rounded to {d.conversion.roundTo}{' '}
              places
            </p>
          </div>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader
          title="Parity"
          description="Cases from the filed manual and Assurant's workbooks only; the prototype rater is never a source."
        />
        <ParityForms manualId={m.id} canManage={me.permissions.includes('rating:manage')} />
        {run.data ? (
          <>
            <p className="border-t border-border px-5 pt-4 text-sm">
              Last run <LocalTime iso={run.data.ranAt} />: <strong>{run.data.passed}</strong> of{' '}
              {run.data.total} cases match.
            </p>
            <Table caption="Parity results">
              <THead>
                <tr>
                  <TH>Case</TH>
                  <TH className="text-right">Expected</TH>
                  <TH className="text-right">Engine</TH>
                  <TH>Differences</TH>
                </tr>
              </THead>
              <tbody>
                {run.data.results.map((r) => (
                  <TR key={r.caseId}>
                    <TD>
                      {r.passed ? (
                        <Badge tone="success">Match</Badge>
                      ) : (
                        <Badge tone="danger">Differs</Badge>
                      )}{' '}
                      {r.name}
                    </TD>
                    <TD className="text-right font-mono text-xs">{r.expectedAmount}</TD>
                    <TD className="text-right font-mono text-xs">{r.actualAmount ?? '—'}</TD>
                    <TD className="text-xs text-muted">
                      {r.error ??
                        (r.factorDifferences.length
                          ? r.factorDifferences
                              .map(
                                (f) =>
                                  `${f.step}: expected ${f.expected}, engine ${f.actual ?? 'none'}`,
                              )
                              .join('; ')
                          : r.passed
                            ? '—'
                            : 'Amount differs')}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </>
        ) : (
          <p className="border-t border-border px-5 py-4 text-sm text-muted">
            {cases.data?.items.length
              ? `${cases.data.items.length} cases, not run yet.`
              : 'No parity cases yet.'}
          </p>
        )}
      </Card>

      {run.data && run.data.passed < run.data.total ? (
        <AgentProposals
          subjectId={m.id}
          kind="parity_explanation"
          agentId="AG-03"
          agentName="Rating Parity and Explanation"
          question={`Explain the parity differences of rate manual ${m.id} (${m.code}, version ${m.version}).`}
          askLabel="Ask for an explanation"
          description="Finds the worksheet step where the engine and the workbook diverge for each failed case, and cites the manual page and the workbook cell. Every citation is checked against the run, the manual and the imported file."
          canAsk={me.permissions.includes('agents:use') && me.permissions.includes('proposals:create')}
          asked={asked}
        />
      ) : null}
      <Card>
        <CardHeader title={`Tables (${d.tables.length})`} />
        {d.tables.length === 0 ? (
          <EmptyState title="No tables" />
        ) : (
          <div className="divide-y divide-border">
            {d.tables.map((t) => (
              <section key={t.id} aria-label={`Table ${t.id}`} className="px-5 py-4">
                <h3 className="text-sm font-semibold text-fg">
                  {t.id} · {t.name} <span className="font-normal text-muted">(page {t.page})</span>
                </h3>
                <p className="mb-2 text-xs text-muted">
                  {t.keys
                    .map(
                      (k) =>
                        `${(RATING_INPUT_LABELS as Record<string, string>)[k.input] ?? k.input} (${k.match === 'band' ? 'band lower bound' : 'exact'})`,
                    )
                    .join(' by ')}
                  {t.unused ? ` · unused ${t.unused}` : ''}
                  {t.unknown ? ` · unknown ${t.unknown}` : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  {t.rows.slice(0, 120).map((r, i) => (
                    <span
                      key={i}
                      className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-fg"
                    >
                      {r.keys.join(' · ')} &rarr; {r.factor}
                    </span>
                  ))}
                  {t.rows.length > 120 ? (
                    <span className="text-xs text-muted">and {t.rows.length - 120} more</span>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
