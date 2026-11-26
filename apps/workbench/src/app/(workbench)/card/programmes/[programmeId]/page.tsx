import { ButtonLink } from '@/components/ui/button';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, FileText } from 'lucide-react';
import type { CardProgramme, EligibilityFeed } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import {
  ELIGIBILITY_RULE_LABELS,
  FEED_STATUS_HELP,
  FEED_STATUS_TONES,
  integer,
  paymentConditionLabel,
  PROGRAMME_STATUS_TONES,
  sentenceCase,
} from '@/lib/format';
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
import {
  EligibilityCheckForm,
  GoLiveDialog,
  ProgrammeStatusDialog,
  UploadFeedForm,
} from '../../card-forms';

export const metadata = { title: 'Card programme' };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-fg">{value}</p>
    </div>
  );
}

export default async function ProgrammePage({
  params,
  searchParams,
}: {
  params: Promise<{ programmeId: string }>;
  searchParams: Promise<{ created?: string; live?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('card:read')) return <AccessDenied permission="card:read" />;
  const { programmeId } = await params;
  const { created, live } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(programmeId)) notFound();

  const [programme, feeds] = await Promise.all([
    load(() => api<CardProgramme>(`/v1/card-programmes/${programmeId}`)),
    load(() =>
      api<{ items: EligibilityFeed[] }>(`/v1/card-programmes/${programmeId}/feeds`, {
        query: { limit: 25 },
      }),
    ),
  ]);
  if (programme.error instanceof ApiProblem && programme.error.problem.code === 'not_found')
    notFound();
  if (programme.error) return <ErrorPanel error={programme.error} />;
  const p = programme.data;
  const canManage = me.permissions.includes('card:manage');
  const canFeeds = me.permissions.includes('card:feeds');
  const feedItems = feeds.data?.items ?? [];
  const testPassed = feedItems.some((f) => f.mode === 'test' && f.status === 'passed');
  // The set-up notice is for a brand-new programme; once feeds arrive, the draft notice says what is next.
  const justCreated = !!created && feedItems.length === 0;
  const attention = feedItems.filter(
    (f) => f.mode === 'live' && (f.status === 'held' || f.status === 'waiting'),
  );

  return (
    <>
      <Link
        href="/card/programmes"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Card programmes
      </Link>
      <PageHeader
        eyebrow={p.accountName}
        title={p.name}
        description={
          <>
            <span className="font-mono">{p.code}</span> · {p.cardProduct} · master policy{' '}
            {p.masterPolicyNumber}
          </>
        }
        actions={
          <>
            <ButtonLink href={`/card/programmes/${p.id}/mapping`} variant="secondary">
              Issuer file mapping
            </ButtonLink>
            <Badge tone={PROGRAMME_STATUS_TONES[p.status]}>{sentenceCase(p.status)}</Badge>
            {canManage && p.status === 'draft' ? (
              <GoLiveDialog programmeId={p.id} testPassed={testPassed} />
            ) : null}
            {canManage && p.status !== 'draft' ? (
              <ProgrammeStatusDialog programmeId={p.id} current={p.status} />
            ) : null}
          </>
        }
      />

      <div className="mb-6 space-y-3">
        {live && p.status === 'live' ? (
          <Notice tone="success" title="The programme is live">
            Live eligibility feeds are now accepted. The first live feed must be a full feed.
          </Notice>
        ) : null}
        {justCreated ? (
          <Notice tone="success" title="Programme set up">
            It is in draft. Ask the issuer for a test feed and upload it below; once a test feed
            passes, the programme can go live.
          </Notice>
        ) : null}
        {p.status === 'draft' && !justCreated ? (
          <Notice tone="primary" title="Draft programme">
            {testPassed
              ? 'A test feed has passed. The programme can go live.'
              : 'Upload a test feed from the issuer. The programme can go live once one passes.'}
          </Notice>
        ) : null}
        {attention.map((f) => (
          <Notice
            key={f.id}
            tone={f.status === 'held' ? 'danger' : 'warning'}
            title={`Feed #${f.sequence ?? '?'} is ${f.status}`}
          >
            {f.statusReason ?? FEED_STATUS_HELP[f.status]}{' '}
            <Link
              className="font-medium text-primary underline"
              href={`/card/programmes/${p.id}/feeds/${f.id}`}
            >
              Review the feed
            </Link>
          </Notice>
        ))}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Eligible today" value={integer(p.eligibleToday ?? 0)} />
        <Stat label="Certificates issued" value={integer(p.certificates)} />
        <Stat
          label="Last applied feed"
          value={p.lastAppliedSequence ? `#${p.lastAppliedSequence}` : 'None yet'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Programme terms" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'Payment condition', value: paymentConditionLabel(p.paymentCondition) },
                { term: 'Eligibility rule', value: ELIGIBILITY_RULE_LABELS[p.eligibilityRule] },
                { term: 'States', value: p.states.join(', ') },
                {
                  term: 'Effective',
                  value: `${p.effectiveFrom} to ${p.effectiveTo ?? 'open-ended'}`,
                },
                { term: 'Reject threshold', value: `${p.maxRejectPercent}% of records` },
                { term: 'Last changed', value: <LocalTime iso={p.updatedAt} /> },
              ]}
            />
          </div>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Eligibility feeds"
              description="Applied exactly once, strictly in sequence. A feed that fails its checks is held and changes nothing."
            />
            {feeds.error ? (
              <p className="px-5 py-4 text-sm text-danger">Feeds could not be loaded.</p>
            ) : feedItems.length === 0 ? (
              <EmptyState
                icon={<FileText className="size-5" />}
                title="No feeds yet"
                description="Feeds the issuer sends, and test feeds, appear here with their results."
              />
            ) : (
              <Table caption={`Eligibility feeds for ${p.name}`}>
                <THead>
                  <tr>
                    <TH>Feed</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Records</TH>
                    <TH className="text-right">Added / updated / removed</TH>
                    <TH className="text-right">Rejected</TH>
                    <TH>Received</TH>
                  </tr>
                </THead>
                <tbody>
                  {feedItems.map((f) => (
                    <TR key={f.id}>
                      <TD>
                        <Link
                          href={`/card/programmes/${p.id}/feeds/${f.id}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {f.sequence ? `#${f.sequence}` : f.fileName}{' '}
                          {f.kind ? sentenceCase(f.kind.toLowerCase()) : ''}
                        </Link>
                        <div className="text-xs text-muted">
                          {f.mode === 'test' ? 'Test · ' : ''}
                          {f.asOfDate ? `as of ${f.asOfDate}` : f.fileName}
                        </div>
                      </TD>
                      <TD>
                        <Badge tone={FEED_STATUS_TONES[f.status]}>{sentenceCase(f.status)}</Badge>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {f.stats ? integer(f.stats.detailRecords) : '—'}
                      </TD>
                      <TD className="text-right tabular-nums text-muted">
                        {f.stats
                          ? `${integer(f.stats.added)} / ${integer(f.stats.updated)} / ${integer(f.stats.removed)}`
                          : '—'}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {f.stats ? integer(f.stats.rejectedRecords) : '—'}
                      </TD>
                      <TD className="text-muted">
                        <LocalTime iso={f.receivedAt} relative />
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {canFeeds && p.status !== 'closed' ? (
            <Card>
              <CardHeader
                title="Upload a feed"
                description="Test feeds are checked and counted but never applied."
              />
              <UploadFeedForm
                programmeId={p.id}
                liveAllowed={p.status === 'live' || p.status === 'suspended'}
              />
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Check eligibility"
              description="Was an account eligible on a date, and which feed says so? Every check is audited."
            />
            <EligibilityCheckForm programmeId={p.id} />
          </Card>
        </div>
      </div>
    </>
  );
}
