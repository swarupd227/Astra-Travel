import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { Referral } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, DescriptionList, Notice, PageHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { EvaluationView, ReferralDecisionForm } from '../../uw-forms';

export const metadata = { title: 'Referral' };

export default async function ReferralPage({ params, searchParams }: { params: Promise<{ referralId: string }>; searchParams: Promise<{ done?: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:read')) return <AccessDenied permission="underwriting:read" />;
  const { referralId } = await params;
  const { done } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(referralId)) notFound();
  const res = await load(() => api<Referral>(`/v1/referrals/${referralId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const r = res.data;
  const names = await peopleNames([r.decidedBy]);
  const sanctions = r.kind === 'sanctions';
  return (
    <>
      <Link href="/underwriting/referrals" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg">
        <ChevronLeft aria-hidden className="size-4" /> Referrals
      </Link>
      <PageHeader
        eyebrow={sanctions ? 'Sanctions hold' : 'Underwriting referral'}
        title={r.caseRef}
        description={`${sentenceCase(r.stage)}${r.evaluation.preview ? ' · evaluated as a preview' : ''}`}
        actions={<Badge tone={r.status === 'open' ? 'warning' : r.status === 'approved' ? 'success' : 'neutral'}>{sentenceCase(r.status)}</Badge>}
      />
      {done ? (
        <div className="mb-6">
          <Notice tone="success" title={`Referral ${done}`}>
            The decision and reason are recorded and sent to the channel that raised the case.
          </Notice>
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Case" description="Built from the rule results; the referral agent's summary will replace it." />
          <div className="p-5">
            <EvaluationView r={r.evaluation} />
          </div>
        </Card>
        <Card>
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
            <p className="text-xs text-muted">Recommendation: {r.recommendation === 'recommend_decline' ? 'a rule recommends a decline' : 'refer for review'}.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
