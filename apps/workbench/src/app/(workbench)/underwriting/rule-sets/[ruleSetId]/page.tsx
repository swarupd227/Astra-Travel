import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ChevronLeft, CircleDashed } from 'lucide-react';
import type { Plan, RuleSet, RuleTestRun } from '@astra/contracts';
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
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import {
  ApproveRuleSetForm,
  PublishRuleSetForm,
  RuleSetEditor,
  RunRuleTestsForm,
} from '../../uw-forms';

export const metadata = { title: 'Rule set' };
const TONES = {
  draft: 'primary',
  approved: 'warning',
  published: 'success',
  superseded: 'neutral',
} as const;
const LABELS: Record<string, string> = {
  approved: 'Approved by a second person',
  values: 'No problems in the rule set',
  tests: 'Every test case passes',
};

export default async function RuleSetPage({
  params,
  searchParams,
}: {
  params: Promise<{ ruleSetId: string }>;
  searchParams: Promise<{ created?: string; done?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:read'))
    return <AccessDenied permission="underwriting:read" />;
  const { ruleSetId } = await params;
  const { created, done } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(ruleSetId)) notFound();
  const res = await load(() => api<RuleSet>(`/v1/rule-sets/${ruleSetId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const rs = res.data;
  const [plan, ready, run, cases] = await Promise.all([
    load(() => api<{ plan: Plan }>(`/v1/plans/${rs.planId}`)),
    load(() =>
      api<{ ready: boolean; checks: { check: string; passed: boolean; detail: string }[] }>(
        `/v1/rule-sets/${ruleSetId}/readiness`,
      ),
    ),
    load(() => api<RuleTestRun>(`/v1/rule-sets/${ruleSetId}/test-runs/latest`)),
    load(() => api<{ items: unknown[] }>(`/v1/plans/${rs.planId}/rule-test-cases`)),
  ]);
  const names = await peopleNames([rs.approvedBy, rs.publishedBy, ...rs.contributors]);
  const manage = me.permissions.includes('underwriting:manage');
  const approve = me.permissions.includes('underwriting:approve');
  const editable = rs.status === 'draft' && manage;
  return (
    <>
      <Link
        href={`/underwriting/plans/${rs.planId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {plan.data?.plan.name ?? 'Plan'}
      </Link>
      <PageHeader
        eyebrow={plan.data ? `${plan.data.plan.code} · ${plan.data.plan.state}` : 'Rule set'}
        title={`Rule set, version ${rs.version}`}
        description={`Effective from ${rs.effectiveFrom}${rs.effectiveTo ? ` to ${rs.effectiveTo}` : ''}`}
        actions={<Badge tone={TONES[rs.status]}>{sentenceCase(rs.status)}</Badge>}
      />
      <div className="mb-6 space-y-3">
        {created ? (
          <Notice tone="success" title="Draft started">
            It copies the latest version. Change the limits and rules, save, add test cases on the
            plan page, and have someone else approve it.
          </Notice>
        ) : null}
        {done ? (
          <Notice tone="success" title={`Rule set ${done}`}>
            {done === 'published'
              ? 'It is used to decide eligibility from its effective date.'
              : 'It can be published once every test case passes.'}
          </Notice>
        ) : null}
        {rs.status !== 'draft' ? (
          <Notice tone="neutral" title={`This version is ${rs.status}`}>
            It cannot change. Start a new draft from the plan page to make changes.
          </Notice>
        ) : null}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0">
          <RuleSetEditor
            ruleSetId={rs.id}
            initial={rs.document}
            effectiveFrom={rs.effectiveFrom}
            problems={rs.problems}
            editable={editable}
          />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Ready to publish?" />
            <div className="space-y-4 p-5">
              {ready.data ? (
                <ul className="space-y-3">
                  {ready.data.checks.map((c) => (
                    <li key={c.check} className="flex gap-2 text-sm">
                      {c.passed ? (
                        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                      ) : (
                        <CircleDashed aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                      )}
                      <span>
                        <span className="font-medium text-fg">{LABELS[c.check]}</span>
                        <span className="sr-only">{c.passed ? ': done' : ': not yet'}</span>
                        <span className="block text-muted">{c.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {rs.status === 'draft' && approve ? (
                rs.contributors.includes(me.subject) ? (
                  <Notice tone="neutral">
                    You built or edited this draft, so someone else must approve it.
                  </Notice>
                ) : rs.problems.length ? (
                  <Notice tone="warning">Fix the problems listed above before approval.</Notice>
                ) : (
                  <ApproveRuleSetForm ruleSetId={rs.id} />
                )
              ) : null}
              {rs.status === 'approved' && approve ? (
                <PublishRuleSetForm ruleSetId={rs.id} ready={!!ready.data?.ready} />
              ) : null}
              <DescriptionList
                items={[
                  {
                    term: 'Built by',
                    value: rs.contributors.map((c) => nameOf(names, c)).join(', '),
                  },
                  { term: 'Approved by', value: nameOf(names, rs.approvedBy) },
                  { term: 'Published by', value: nameOf(names, rs.publishedBy) },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader
              title="Test cases"
              description="Evaluated with this rule set, the plan's current version and the data in force."
            />
            <div className="space-y-3 p-5">
              {manage ? (
                <RunRuleTestsForm ruleSetId={rs.id} cases={cases.data?.items.length ?? 0} />
              ) : null}
              <p className="text-xs text-muted">
                <Link
                  href={`/underwriting/plans/${rs.planId}`}
                  className="text-primary hover:underline"
                >
                  Manage the plan's test cases
                </Link>
              </p>
              {run.data ? (
                <>
                  <p className="text-sm">
                    Last run <LocalTime iso={run.data.ranAt} />: <strong>{run.data.passed}</strong>{' '}
                    of {run.data.total} pass.
                  </p>
                  <ul className="space-y-2">
                    {run.data.results.map((r) => (
                      <li key={r.caseId} className="text-sm">
                        <Badge tone={r.passed ? 'success' : 'danger'}>
                          {r.passed ? 'Pass' : 'Fail'}
                        </Badge>{' '}
                        {r.name}
                        <span className="block text-xs text-muted">{r.message}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
