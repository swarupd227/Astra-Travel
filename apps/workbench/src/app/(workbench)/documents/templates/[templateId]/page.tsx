import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ChevronLeft, CircleX } from 'lucide-react';
import type { Template } from '@astra/contracts';
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
import { AgentProposals } from '../../../proposals/agent-proposals';
import { ReleaseTemplateForm } from '../../document-forms';
import { TEMPLATE_TONES } from '../../tones';

export const metadata = { title: 'Document template' };

const CHECK_LABELS: Record<string, string> = {
  assembled: 'Assembled with nothing left in brackets',
  accounted: 'Every variable of the approved map accounted for',
  in_range: 'Every value within its filed range or options',
  quality: 'No finding of the Document Quality agent holds it',
};

export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ templateId: string }>;
  searchParams: Promise<{ released?: string; asked?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('documents:read'))
    return <AccessDenied permission="documents:read" />;
  const { templateId } = await params;
  const { released, asked } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(templateId)) notFound();
  const res = await load(() => api<Template>(`/v1/document-templates/${templateId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const t = res.data;
  const names = await peopleNames([t.createdBy, t.releasedBy]);
  const me_ = me.subject;
  const canRelease = me.permissions.includes('documents:release');
  const reason = !canRelease
    ? 'You need the documents:release permission to release a template.'
    : t.status !== 'draft'
      ? `This template is ${t.status}.`
      : t.createdBy === me_
        ? 'You made this template, so someone else releases it.'
        : !t.releasable
          ? 'Release is not possible until every check passes and no finding holds it.'
          : null;
  return (
    <>
      <Link
        href="/documents"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Document templates
      </Link>
      <PageHeader
        eyebrow={`${t.planCode} · plan version ${t.planVersion}`}
        title={`${sentenceCase(t.kind)} template, version ${t.version}`}
        description={`Assembled from ${t.form.formNumber} edition ${t.form.edition} and its approved variable map (version ${t.form.mapVersion}) with the plan’s values.`}
        actions={<Badge tone={TEMPLATE_TONES[t.status]}>{sentenceCase(t.status)}</Badge>}
      />
      {released ? (
        <div className="mb-6">
          <Notice tone="success" title="Released">
            New policies on this plan version are issued with this template.
          </Notice>
        </div>
      ) : null}

      <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Checks"
              description="Run when the template was assembled and again at release."
            />
            <ul className="divide-y divide-border">
              {t.checks.map((c) => (
                <li key={c.check} className="flex items-start gap-3 px-5 py-3 text-sm">
                  {c.passed ? (
                    <CheckCircle2
                      aria-label="Passed"
                      className="mt-0.5 size-4 shrink-0 text-success"
                    />
                  ) : (
                    <CircleX aria-label="Failed" className="mt-0.5 size-4 shrink-0 text-danger" />
                  )}
                  <div>
                    <p className="font-medium text-fg">{CHECK_LABELS[c.check] ?? c.check}</p>
                    <p className="text-muted">{c.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            {t.problems.length ? (
              <div className="border-t border-border p-5">
                <p className="mb-2 text-sm font-medium text-fg">
                  Problems to fix in the plan or the form
                </p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-danger">
                  {t.problems.map((p, i) => (
                    <li key={i}>{p.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <AgentProposals
            subjectId={t.id}
            kind="document_quality"
            agentId="AG-07"
            agentName="Document Quality"
            question={`Check template ${t.id} (the ${t.kind} of plan ${t.planCode}, version ${t.planVersion}) against the plan and the filed form.`}
            askLabel="Ask for a quality check"
            description="Reads the assembled wording against the plan’s values and the filed form and reports what is wrong, quoting the text. An open finding holds the release until a person reviews it."
            canAsk={
              me.permissions.includes('agents:use') &&
              me.permissions.includes('proposals:create') &&
              t.status === 'draft'
            }
            asked={asked}
          />

          <Card>
            <CardHeader
              title="Assembled wording"
              description="This is the text policies are issued with, after the declarations for the policy."
            />
            <pre
              className="max-h-[32rem] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed text-fg"
              tabIndex={0}
              aria-label="Assembled wording"
            >
              {t.text}
            </pre>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Record" />
            <div className="p-5">
              <DescriptionList
                items={[
                  {
                    term: 'Plan',
                    value: (
                      <Link
                        className="text-primary hover:underline"
                        href={`/plans/versions/${t.planVersionId}`}
                      >
                        {t.planName}
                      </Link>
                    ),
                  },
                  { term: 'Filled', value: String(t.inserted) },
                  {
                    term: 'Optional benefits left out',
                    value: t.removed.length ? t.removed.join(', ') : 'None',
                  },
                  { term: 'Made by', value: nameOf(names, t.createdBy) },
                  { term: 'Made', value: <LocalTime iso={t.createdAt} /> },
                  ...(t.releasedBy
                    ? [
                        { term: 'Released by', value: nameOf(names, t.releasedBy) },
                        { term: 'Released', value: <LocalTime iso={t.releasedAt!} /> },
                      ]
                    : []),
                ]}
              />
            </div>
          </Card>
          {t.status === 'draft' ? (
            <Card>
              <CardHeader
                title="Release"
                description="Someone other than the person who made it releases it."
              />
              <div className="p-5">
                <ReleaseTemplateForm templateId={t.id} disabledReason={reason} />
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
