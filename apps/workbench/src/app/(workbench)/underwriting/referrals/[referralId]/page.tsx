import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Referral, ReferralSummary } from '@astra/contracts';
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
import { AgentMark } from '@/components/copilot/agent-mark';
import { BackLink } from '@/components/ui/back-link';
import { AutoRefresh } from '../../../proposals/proposal-forms';
import { EvaluationView, ReferralDecisionForm } from '../../uw-forms';
import { AskSummaryForm, SummaryDecisionForm } from './summary-forms';

export const metadata = { title: 'Referral' };

export default async function ReferralPage({
  params,
  searchParams,
}: {
  params: Promise<{ referralId: string }>;
  searchParams: Promise<{ done?: string; asked?: string; askError?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:read'))
    return <AccessDenied permission="underwriting:read" />;
  const { referralId } = await params;
  const { done, asked, askError } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(referralId)) notFound();
  const res = await load(() => api<Referral>(`/v1/referrals/${referralId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const r = res.data;
  const summaries = await load(() =>
    api<{ items: ReferralSummary[] }>(`/v1/referrals/${referralId}/summaries`),
  );
  const summaryList = summaries.data?.items ?? [];
  const canAsk =
    r.kind === 'underwriting' &&
    r.status === 'open' &&
    me.permissions.includes('agents:use') &&
    me.permissions.includes('underwriting:evaluate');
  const canJudge = me.permissions.includes('referrals:decide');
  const names = await peopleNames([r.decidedBy]);
  const sanctions = r.kind === 'sanctions';
  return (
    <>
      <BackLink href="/underwriting/referrals">Referrals</BackLink>
      <PageHeader
        eyebrow={sanctions ? 'Sanctions hold' : 'Underwriting referral'}
        title={r.caseRef}
        description={`${sentenceCase(r.stage)}${r.evaluation.preview ? ' · evaluated as a preview' : ''}`}
        actions={
          <Badge
            tone={r.status === 'open' ? 'warning' : r.status === 'approved' ? 'success' : 'neutral'}
          >
            {sentenceCase(r.status)}
          </Badge>
        }
      />
      {done ? (
        <div className="mb-6">
          <Notice tone="success" title={`Referral ${done}`}>
            The decision and reason are recorded and sent to the channel that raised the case.
          </Notice>
        </div>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          {r.kind === 'underwriting' ? (
            <Card className="ai-surface overflow-hidden">
              <CardHeader
                title={
                  <span className="flex items-center gap-2.5">
                    <AgentMark size="sm" /> Summary by the Underwriting Referral agent
                  </span>
                }
                description="It reads the case and suggests what to do. You decide; a decline is always your decision."
                actions={
                  canAsk ? (
                    <AskSummaryForm
                      referralId={r.id}
                      label={
                        summaryList.length ? 'Ask for a new summary' : 'Summarise this referral'
                      }
                    />
                  ) : undefined
                }
              />
              <div className="space-y-6 p-5">
                <AutoRefresh active={!!asked && summaryList.length === 0} />
                {askError ? (
                  <Notice tone="danger" title="The agent could not be asked">
                    {askError}
                  </Notice>
                ) : null}
                {summaryList.length === 0 && !asked ? (
                  <p className="text-sm text-muted">
                    No summary yet.{canAsk ? ' Ask the agent for one.' : ''}
                  </p>
                ) : null}
                {summaryList.map((s) => {
                  const shown =
                    s.decision?.decision === 'edited' && s.decision.edited
                      ? s.decision.edited.summary
                      : s.summary;
                  return (
                    <section
                      key={s.id}
                      aria-label={`Summary written ${s.createdAt}`}
                      className="rounded-xl border border-border bg-surface p-4"
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge
                          tone={
                            s.suggested === 'decline'
                              ? 'warning'
                              : s.suggested === 'approve'
                                ? 'success'
                                : 'neutral'
                          }
                        >
                          Suggests: {sentenceCase(s.suggested)}
                        </Badge>
                        {s.decision ? (
                          <Badge tone={s.decision.decision === 'rejected' ? 'danger' : 'primary'}>
                            You{' '}
                            {s.decision.decision === 'edited'
                              ? 'corrected it'
                              : s.decision.decision}
                          </Badge>
                        ) : (
                          <Badge tone="warning">Not yet judged</Badge>
                        )}
                        <span className="text-xs text-muted">
                          {s.agentId ?? 'Agent'} · <LocalTime iso={s.createdAt} />
                        </span>
                      </div>
                      <p className="whitespace-pre-line text-sm text-fg">{shown}</p>
                      <p className="mt-2 text-xs text-muted">
                        Rules relied on:{' '}
                        {s.rulesCited
                          .map(
                            (c) =>
                              `${c}${s.verification.rulesChecked.find((x) => x.code === c)?.fired ? ' (fired, checked)' : ''}`,
                          )
                          .join(', ')}
                      </p>
                      {s.decision?.reason ? (
                        <p className="mt-1 text-xs text-muted">Reason given: {s.decision.reason}</p>
                      ) : null}
                      {s.runId ? (
                        <p className="mt-2 text-sm">
                          <Link
                            href={`/agents/runs/${s.runId}/review`}
                            className="font-medium text-primary hover:underline"
                          >
                            How the agent reached this: its inputs, evidence and limits
                          </Link>
                        </p>
                      ) : null}
                      {!s.decision && canJudge ? (
                        <SummaryDecisionForm summaryId={s.id} summary={s.summary} />
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </Card>
          ) : null}
          <Card aria-labelledby="case">
            <CardHeader titleId="case" title="Case" description="What the rules found." />
            <div className="p-5">
              <EvaluationView r={r.evaluation} />
            </div>
          </Card>
        </div>
        <Card className="self-start xl:sticky xl:top-20">
          <CardHeader title={r.status === 'open' ? 'Decide' : 'Decision'} />
          <div className="space-y-4 p-5">
            {r.status === 'open' ? (
              me.permissions.includes('referrals:decide') ? (
                <ReferralDecisionForm referralId={r.id} sanctions={sanctions} />
              ) : (
                <Notice tone="neutral">You can read referrals but not decide them.</Notice>
              )
            ) : (
              <DescriptionList
                items={[
                  { term: 'Decision', value: sentenceCase(r.status) },
                  { term: 'Decided by', value: nameOf(names, r.decidedBy) },
                  { term: 'When', value: r.decidedAt ? <LocalTime iso={r.decidedAt} /> : '—' },
                  { term: 'Reason', value: r.decisionReason ?? '—' },
                ]}
              />
            )}
            <p className="text-xs text-muted">
              Recommendation:{' '}
              {r.recommendation === 'recommend_decline'
                ? 'a rule recommends a decline'
                : 'refer for review'}
              .
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
