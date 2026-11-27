import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { Plan, PlanTestCase, PlanVersion } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, DescriptionList, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { VERSION_TONES } from '../tones';
import { RemoveTestCaseButton, StartDraftForm, TestCaseDialog } from '../plan-forms';

export const metadata = { title: 'Plan' };

const KIND_LABELS = { base: 'Base plan', state: 'State plan', account: 'Account plan' } as const;

export default async function PlanPage({ params }: { params: Promise<{ planId: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('plans:read')) return <AccessDenied permission="plans:read" />;
  const { planId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) notFound();
  const [res, cases] = await Promise.all([
    load(() =>
      api<{ plan: Plan; versions: Omit<PlanVersion, 'document' | 'problems'>[] }>(
        `/v1/plans/${planId}`,
      ),
    ),
    load(() => api<{ items: PlanTestCase[] }>(`/v1/plans/${planId}/test-cases`)),
  ]);
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const { plan, versions } = res.data;
  const parent = plan.parentPlanId
    ? await load(() => api<{ plan: Plan }>(`/v1/plans/${plan.parentPlanId}`))
    : null;
  const names = await peopleNames([
    plan.createdBy,
    ...versions.flatMap((v) => [v.approvedBy, v.publishedBy]),
  ]);
  const canManage = me.permissions.includes('plans:manage');

  return (
    <>
      <Link
        href="/plans"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Plans
      </Link>
      <PageHeader
        eyebrow={`${KIND_LABELS[plan.kind]}${plan.state ? ` · ${plan.state}` : ''}`}
        title={plan.name}
        description={`${plan.code} · ${plan.term === 'annual' ? 'Annual' : 'Single trip'}`}
        actions={
          plan.current ? (
            <Badge tone={VERSION_TONES[plan.current.status as keyof typeof VERSION_TONES]}>
              v{plan.current.version} {plan.current.status}
            </Badge>
          ) : null
        }
      />

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="About" />
          <div className="p-5">
            <DescriptionList
              items={[
                {
                  term: 'Made from',
                  value: parent?.data ? (
                    <Link
                      className="text-primary hover:underline"
                      href={`/plans/${parent.data.plan.id}`}
                    >
                      {parent.data.plan.code}
                    </Link>
                  ) : (
                    'Benefit catalogue'
                  ),
                },
                { term: 'Created by', value: nameOf(names, plan.createdBy) },
                { term: 'Created', value: <LocalTime iso={plan.createdAt} /> },
              ]}
            />
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Versions"
            description="One draft at a time. Approved and published versions never change; a new draft copies the current version."
          />
          <Table caption="Versions">
            <THead>
              <tr>
                <TH>Version</TH>
                <TH>Status</TH>
                <TH>Effective</TH>
                <TH>Approved by</TH>
                <TH>Published by</TH>
              </tr>
            </THead>
            <tbody>
              {versions.map((v) => (
                <TR key={v.id}>
                  <TD>
                    <Link
                      href={`/plans/versions/${v.id}`}
                      className="font-medium text-fg hover:text-primary hover:underline"
                    >
                      Version {v.version}
                    </Link>
                  </TD>
                  <TD>
                    <Badge tone={VERSION_TONES[v.status]}>{sentenceCase(v.status)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted">
                    {v.effectiveFrom}
                    {v.effectiveTo ? ` to ${v.effectiveTo}` : ''}
                  </TD>
                  <TD>{nameOf(names, v.approvedBy)}</TD>
                  <TD>{nameOf(names, v.publishedBy)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
          {canManage && !plan.draft && plan.current ? (
            <div className="border-t border-border px-5 py-4">
              <StartDraftForm planId={plan.id} />
            </div>
          ) : null}
        </Card>
      </div>

      {plan.kind !== 'base' ? (
        <Card>
          <CardHeader
            title="Rating test cases"
            description="Quotes with the totals expected to the cent. Every case must pass on a version before it is published."
            actions={canManage ? <TestCaseDialog planId={plan.id} /> : null}
          />
          {cases.data?.items.length ? (
            <Table caption="Rating test cases">
              <THead>
                <tr>
                  <TH>Case</TH>
                  <TH>Rate date</TH>
                  <TH className="text-right">Travellers</TH>
                  <TH className="text-right">Expected</TH>
                  {canManage ? <TH className="sr-only">Remove</TH> : null}
                </tr>
              </THead>
              <tbody>
                {cases.data.items.map((c) => (
                  <TR key={c.id}>
                    <TD>{c.name}</TD>
                    <TD>{c.input.rateDate}</TD>
                    <TD className="text-right tabular-nums">{c.input.travellers.length}</TD>
                    <TD className="text-right font-mono text-xs">
                      {[
                        ...(c.expected.policyTotal ? [`total ${c.expected.policyTotal}`] : []),
                        ...Object.entries(c.expected.perBenefit ?? {}).map(([b, v]) => `${b} ${v}`),
                      ].join(' · ')}
                    </TD>
                    {canManage ? (
                      <TD className="w-12">
                        <RemoveTestCaseButton planId={plan.id} caseId={c.id} name={c.name} />
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="border-t border-border px-5 py-4 text-sm text-muted">
              No test cases yet.
            </p>
          )}
        </Card>
      ) : null}
    </>
  );
}
