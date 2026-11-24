import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { Plan, RuleSet, RuleTestCase } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { RemoveCaseButton, StartRuleSetForm, TestCaseDialog } from '../../uw-forms';

export const metadata = { title: 'Plan rules' };
const TONES = { draft: 'primary', approved: 'warning', published: 'success', superseded: 'neutral' } as const;

export default async function PlanRulesPage({ params }: { params: Promise<{ planId: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:read')) return <AccessDenied permission="underwriting:read" />;
  const { planId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) notFound();
  const [plan, sets, cases] = await Promise.all([
    load(() => api<{ plan: Plan }>(`/v1/plans/${planId}`)),
    load(() => api<{ items: Omit<RuleSet, 'document' | 'problems'>[] }>(`/v1/plans/${planId}/rule-sets`)),
    load(() => api<{ items: RuleTestCase[] }>(`/v1/plans/${planId}/rule-test-cases`)),
  ]);
  if (plan.error instanceof ApiProblem && plan.error.problem.code === 'not_found') notFound();
  if (plan.error) return <ErrorPanel error={plan.error} />;
  if (sets.error) return <ErrorPanel error={sets.error} />;
  const p = plan.data.plan;
  const items = sets.data.items;
  const names = await peopleNames(items.flatMap((s) => [s.approvedBy, s.publishedBy]));
  const manage = me.permissions.includes('underwriting:manage');
  const hasDraft = items.some((s) => s.status === 'draft');
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Link href="/underwriting/plans" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg">
        <ChevronLeft aria-hidden className="size-4" /> Rule sets
      </Link>
      <PageHeader eyebrow={`${p.kind === 'state' ? 'State' : 'Account'} plan · ${p.state}`} title={p.name} description={`${p.code}. Rule set versions and the test cases every version must pass.`} />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Rule set versions" />
          <Table caption="Rule set versions">
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
              {items.length === 0 ? (
                <TR>
                  <TD colSpan={5} className="text-muted">
                    No rule set yet.
                  </TD>
                </TR>
              ) : null}
              {items.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <Link href={`/underwriting/rule-sets/${s.id}`} className="font-medium text-fg hover:text-primary hover:underline">
                      Version {s.version}
                    </Link>
                  </TD>
                  <TD>
                    <Badge tone={TONES[s.status]}>{sentenceCase(s.status)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted">
                    {s.effectiveFrom}
                    {s.effectiveTo ? ` to ${s.effectiveTo}` : ''}
                  </TD>
                  <TD>{nameOf(names, s.approvedBy)}</TD>
                  <TD>{nameOf(names, s.publishedBy)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
          {manage && !hasDraft ? (
            <div className="border-t border-border px-5 py-4">
              <StartRuleSetForm planId={p.id} />
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader
            title="Test cases"
            description="Cases with the outcome expected. A rule set cannot be published while any fails."
            actions={manage ? <TestCaseDialog planId={p.id} today={today} /> : null}
          />
          {cases.data?.items.length ? (
            <Table caption="Rule test cases">
              <THead>
                <tr>
                  <TH>Case</TH>
                  <TH>Stage</TH>
                  <TH>Expected</TH>
                  {manage ? <TH className="sr-only">Remove</TH> : null}
                </tr>
              </THead>
              <tbody>
                {cases.data.items.map((c) => (
                  <TR key={c.id}>
                    <TD>{c.name}</TD>
                    <TD>{sentenceCase(c.input.stage)}</TD>
                    <TD className="text-xs">
                      {[
                        sentenceCase(c.expected.outcome),
                        ...(c.expected.referralRules?.length ? [`rules ${c.expected.referralRules.join(', ')}`] : []),
                        ...(c.expected.waiver !== undefined ? [`waiver ${c.expected.waiver ? 'applies' : 'does not apply'}`] : []),
                        ...(c.expected.cfarOffered !== undefined ? [`CFAR ${c.expected.cfarOffered ? 'offered' : 'not offered'}`] : []),
                      ].join(' · ')}
                    </TD>
                    {manage ? (
                      <TD className="w-12">
                        <RemoveCaseButton planId={p.id} caseId={c.id} name={c.name} />
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="border-t border-border px-5 py-4 text-sm text-muted">No test cases yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}
