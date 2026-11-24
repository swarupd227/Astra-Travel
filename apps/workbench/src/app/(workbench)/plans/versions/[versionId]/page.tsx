import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ChevronLeft, CircleDashed } from 'lucide-react';
import type { CatalogueDocument, Plan, PlanDiff, PlanDocument, PlanTestRun, PlanVersion } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, DescriptionList, Notice, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { PlanBuilder, type BuilderVariable } from '../../builder';
import { ApproveVersionForm, PublishVersionForm, RunTestsForm } from '../../plan-forms';
import { VERSION_TONES } from '../../tones';

export const metadata = { title: 'Plan version' };

type Readiness = { ready: boolean; checks: { check: string; passed: boolean; detail: string }[]; links: Record<string, string> };
const CHECK_LABELS: Record<string, string> = {
  approved: 'Approved by a second person',
  catalogue: 'Benefit catalogue is the approved version',
  forms_filed: 'Forms filed and approved in the state',
  manuals: 'Published rate manual for each rated benefit',
  values: 'Every value within its filed range',
  tests: 'Every test case passes',
};
const AREA_LABELS: Record<PlanDiff['changes'][number]['area'], string> = {
  benefit: 'Benefit',
  upgrade: 'Upgrade',
  covered_reason: 'Covered reason',
  value: 'Value',
  setting: 'Condition',
  bound: 'Account bound',
  timing: 'Cover dates',
  link: 'Form or manual',
  dates: 'Dates',
};

export default async function VersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ versionId: string }>;
  searchParams: Promise<{ created?: string; done?: string; compare?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('plans:read')) return <AccessDenied permission="plans:read" />;
  const { versionId } = await params;
  const { created, done, compare } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) notFound();
  const res = await load(() => api<PlanVersion>(`/v1/plan-versions/${versionId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const v = res.data;
  const [planRes, builder, readiness, run] = await Promise.all([
    load(() => api<{ plan: Plan; versions: { id: string; version: number; status: string }[] }>(`/v1/plans/${v.planId}`)),
    load(() =>
      api<{ catalogue: CatalogueDocument; catalogueVersion: number; variables: BuilderVariable[]; required: string[]; bounds: PlanDocument['bounds'] }>(
        `/v1/plan-versions/${versionId}/builder`,
      ),
    ),
    load(() => api<Readiness>(`/v1/plan-versions/${versionId}/readiness`)),
    load(() => api<PlanTestRun>(`/v1/plan-versions/${versionId}/test-runs/latest`)),
  ]);
  if (planRes.error) return <ErrorPanel error={planRes.error} />;
  if (builder.error) return <ErrorPanel error={builder.error} />;
  const { plan, versions } = planRes.data;
  const others = versions.filter((x) => x.id !== v.id);
  const compareWith = compare && others.some((o) => o.id === compare) ? compare : null;
  const diff = compareWith ? await load(() => api<PlanDiff>(`/v1/plan-versions/${v.id}/compare?with=${compareWith}`)) : null;
  const names = await peopleNames([v.approvedBy, v.publishedBy, ...v.contributors]);
  const canManage = me.permissions.includes('plans:manage');
  const canApprove = me.permissions.includes('plans:approve');
  const editable = v.status === 'draft' && canManage;
  const cases = run.data?.total;

  return (
    <>
      <Link href={`/plans/${plan.id}`} className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg">
        <ChevronLeft aria-hidden className="size-4" /> {plan.name}
      </Link>
      <PageHeader
        eyebrow={`${plan.code}${plan.state ? ` · ${plan.state}` : ''}`}
        title={`Version ${v.version}`}
        description={`Effective from ${v.effectiveFrom}${v.effectiveTo ? ` to ${v.effectiveTo}` : ''} · benefit catalogue v${builder.data.catalogueVersion}`}
        actions={<Badge tone={VERSION_TONES[v.status]}>{sentenceCase(v.status)}</Badge>}
      />
      <div className="mb-6 space-y-3">
        {created ? (
          <Notice tone="success" title="Plan created">
            This is its first draft. Choose benefits, covered reasons, values and conditions, then save. Someone else approves it.
          </Notice>
        ) : null}
        {done ? (
          <Notice tone="success" title={`Version ${done}`}>
            {done === 'published'
              ? 'It is used for quotes from its effective date.'
              : plan.kind === 'base'
                ? 'State plans can now be made from it.'
                : 'It can be published once every check passes.'}
          </Notice>
        ) : null}
        {v.status !== 'draft' ? (
          <Notice tone="neutral" title={`This version is ${v.status}`}>
            It cannot change. {canManage && !plan.draft ? 'Start a new draft from the plan page to make changes.' : ''}
          </Notice>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0">
          <PlanBuilder
            versionId={v.id}
            kind={plan.kind}
            initial={v.document}
            effectiveFrom={v.effectiveFrom}
            catalogue={builder.data.catalogue}
            variables={builder.data.variables}
            bounds={builder.data.bounds}
            problems={v.problems}
            editable={editable}
          />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title={plan.kind === 'base' ? 'Approval' : 'Ready to publish?'} />
            <div className="space-y-4 p-5">
              {readiness.data ? (
                <ul className="space-y-3">
                  {readiness.data.checks
                    .filter((c) => plan.kind !== 'base' || c.check !== 'forms_filed')
                    .map((c) => (
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
              {plan.kind === 'base' ? (
                <p className="text-xs text-muted">Base plans are templates: they are approved, then state plans are made from them and published.</p>
              ) : null}
              {v.status === 'draft' && canApprove ? (
                v.contributors.includes(me.subject) ? (
                  <Notice tone="neutral">You built or edited this draft, so someone else must approve it.</Notice>
                ) : v.problems.length ? (
                  <Notice tone="warning">The draft has {v.problems.length} thing{v.problems.length === 1 ? '' : 's'} to finish before it can be approved.</Notice>
                ) : (
                  <ApproveVersionForm versionId={v.id} />
                )
              ) : null}
              {v.status === 'approved' && canApprove && plan.kind !== 'base' ? (
                <PublishVersionForm versionId={v.id} ready={!!readiness.data?.ready} />
              ) : null}
              <DescriptionList
                items={[
                  { term: 'Built by', value: v.contributors.map((c) => nameOf(names, c)).join(', ') },
                  { term: 'Approved by', value: nameOf(names, v.approvedBy) },
                  { term: 'Published by', value: nameOf(names, v.publishedBy) },
                  { term: 'Last saved', value: <LocalTime iso={v.updatedAt} /> },
                ]}
              />
            </div>
          </Card>

          {plan.kind !== 'base' ? (
            <Card>
              <CardHeader title="Test cases" description="Rated with this version and the published manuals, compared to the cent." />
              <div className="space-y-3 p-5">
                {canManage ? <RunTestsForm versionId={v.id} cases={cases ?? 0} /> : null}
                <p className="text-xs text-muted">
                  <Link href={`/plans/${plan.id}`} className="text-primary hover:underline">
                    Manage the plan’s test cases
                  </Link>
                </p>
                {run.data ? (
                  <>
                    <p className="text-sm">
                      Last run <LocalTime iso={run.data.ranAt} />: <strong>{run.data.passed}</strong> of {run.data.total} pass.
                    </p>
                    <ul className="space-y-2">
                      {run.data.results.map((r) => (
                        <li key={r.caseId} className="text-sm">
                          <Badge tone={r.passed ? 'success' : 'danger'}>{r.passed ? 'Pass' : 'Fail'}</Badge> {r.name}
                          <span className="block text-xs text-muted">{r.message}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </Card>
          ) : null}

          {others.length ? (
            <Card>
              <CardHeader title="Compare" description="What changed from another version." />
              <form className="flex items-end gap-2 px-5 pt-4" method="get">
                <label className="flex-1 space-y-1.5 text-sm font-medium text-fg">
                  Compare with
                  <select
                    name="compare"
                    defaultValue={compareWith ?? ''}
                    className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
                  >
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        Version {o.version} ({o.status})
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-subtle">
                  Compare
                </button>
              </form>
              <div className="p-5">
                {diff?.data ? (
                  diff.data.changes.length ? (
                    <Table caption={`Changes from version ${diff.data.from.version}`}>
                      <THead>
                        <tr>
                          <TH>What</TH>
                          <TH>Before</TH>
                          <TH>After</TH>
                        </tr>
                      </THead>
                      <tbody>
                        {diff.data.changes.map((c, i) => (
                          <TR key={i}>
                            <TD>
                              <span className="block text-xs text-muted">{AREA_LABELS[c.area]}</span>
                              <span className="font-mono text-xs">{c.item}</span>
                            </TD>
                            <TD className="text-xs break-all">{c.before ?? '—'}</TD>
                            <TD className="text-xs break-all">{c.after ?? '—'}</TD>
                          </TR>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <p className="text-sm text-muted">No differences.</p>
                  )
                ) : (
                  <p className="text-sm text-muted">Choose a version to compare.</p>
                )}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
