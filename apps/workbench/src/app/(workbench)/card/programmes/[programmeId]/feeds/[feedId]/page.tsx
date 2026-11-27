import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, ListChecks } from 'lucide-react';
import type {
  CardProgramme,
  EligibilityFeed,
  FeedRejection,
  Proposal,
  RejectionExplanation,
} from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { nameOf, peopleNames } from '@/lib/people';
import {
  bytes,
  FEED_STATUS_HELP,
  FEED_STATUS_TONES,
  integer,
  readParams,
  sentenceCase,
  type SearchParams,
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
import { Pager, Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { RejectFeedDialog } from '../../../../card-forms';
import { AskAgentForm, ExplanationsForm } from '../../mapping/forms';

export const metadata = { title: 'Eligibility feed' };

export default async function FeedPage({
  params,
  searchParams,
}: {
  params: Promise<{ programmeId: string; feedId: string }>;
  searchParams: SearchParams;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('card:read')) return <AccessDenied permission="card:read" />;
  const { programmeId, feedId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(programmeId) || !/^[0-9a-f-]{36}$/i.test(feedId)) notFound();
  const query = await readParams(searchParams);
  const base = `/card/programmes/${programmeId}/feeds/${feedId}`;

  const [programme, feed, rejections] = await Promise.all([
    load(() => api<CardProgramme>(`/v1/card-programmes/${programmeId}`)),
    load(() => api<EligibilityFeed>(`/v1/card-programmes/${programmeId}/feeds/${feedId}`)),
    load(() =>
      api<{ items: FeedRejection[]; nextCursor: string | null }>(
        `/v1/card-programmes/${programmeId}/feeds/${feedId}/rejections`,
        {
          query: { cursor: query.cursor, limit: 50 },
        },
      ),
    ),
  ]);
  for (const r of [programme, feed]) {
    if (r.error instanceof ApiProblem && r.error.problem.code === 'not_found') notFound();
  }
  if (programme.error) return <ErrorPanel error={programme.error} />;
  if (feed.error) return <ErrorPanel error={feed.error} />;
  const p = programme.data;
  const f = feed.data;
  const s = f.stats;
  const names = await peopleNames([f.receivedBy]);
  // The agent's open explanation of this feed's rejected records, if it has made one.
  const found = me.permissions.includes('proposals:read')
    ? await load(() =>
        api<{ items: Omit<Proposal, 'content'>[] }>('/v1/agent-proposals', {
          query: { subjectId: feedId, kind: 'feed_rejections', status: 'open' },
        }),
      )
    : null;
  const openId = found?.data?.items[0]?.id;
  const proposal = openId
    ? (await load(() => api<Proposal>(`/v1/agent-proposals/${openId}`))).data
    : null;
  const explained = proposal?.content as
    { explanations?: RejectionExplanation[]; counts?: Record<string, number> } | undefined;
  const canAsk =
    me.permissions.includes('agents:use') &&
    me.permissions.includes('proposals:create') &&
    (rejections.data?.items.length ?? 0) > 0;
  const canReject =
    me.permissions.includes('card:feeds') &&
    me.accountScope.type === 'all' &&
    (f.status === 'held' || f.status === 'waiting');

  return (
    <>
      <Link
        href={`/card/programmes/${p.id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {p.name}
      </Link>
      <PageHeader
        eyebrow={f.mode === 'test' ? 'Test eligibility feed' : 'Eligibility feed'}
        title={
          f.sequence
            ? `Feed #${f.sequence}${f.kind ? ` · ${sentenceCase(f.kind.toLowerCase())}` : ''}`
            : f.fileName
        }
        description={f.asOfDate ? `As of ${f.asOfDate}` : 'Not yet read'}
        actions={
          <>
            <Badge tone={FEED_STATUS_TONES[f.status]}>{sentenceCase(f.status)}</Badge>
            {canReject ? <RejectFeedDialog programmeId={p.id} feedId={f.id} /> : null}
          </>
        }
      />
      <div className="mb-6">
        <Notice
          tone={
            f.status === 'held' || f.status === 'failed'
              ? 'danger'
              : f.status === 'waiting'
                ? 'warning'
                : 'neutral'
          }
          title={FEED_STATUS_HELP[f.status]}
        >
          {f.statusReason ??
            (f.status === 'applied'
              ? 'Every change in the file is now in the eligibility ledger.'
              : 'No problems were found.')}
        </Notice>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="File" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'File name', value: f.fileName },
                { term: 'Size', value: bytes(f.sizeBytes) },
                {
                  term: 'SHA-256',
                  value: <span className="font-mono text-xs break-all">{f.sha256}</span>,
                },
                { term: 'Received', value: <LocalTime iso={f.receivedAt} /> },
                { term: 'Received by', value: nameOf(names, f.receivedBy) },
                {
                  term: 'Processed',
                  value: f.processedAt ? <LocalTime iso={f.processedAt} /> : 'Not yet',
                },
                {
                  term: 'Processing time',
                  value: f.durationMs !== null ? `${(f.durationMs / 1000).toFixed(1)} s` : '—',
                },
              ]}
            />
          </div>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Result"
              description={
                f.mode === 'test'
                  ? 'What this file would change. Test feeds are never applied.'
                  : undefined
              }
            />
            <div className="p-5">
              {s ? (
                <DescriptionList
                  items={[
                    { term: 'Detail records', value: integer(s.detailRecords) },
                    { term: 'Rejected records', value: integer(s.rejectedRecords) },
                    { term: 'Accounts added', value: integer(s.added) },
                    { term: 'Accounts updated', value: integer(s.updated) },
                    { term: 'Accounts removed', value: integer(s.removed) },
                    { term: 'Unchanged', value: integer(s.unchanged) },
                    { term: 'Certificates issued', value: integer(s.certificatesIssued) },
                  ]}
                />
              ) : (
                <p className="text-sm text-muted">The feed has not been processed yet.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Rejected records"
              description="By line number. Card numbers are never stored, so those rows show no reference."
            />
            {rejections.error ? (
              <p className="px-5 py-4 text-sm text-danger">Rejections could not be loaded.</p>
            ) : rejections.data.items.length === 0 ? (
              <EmptyState icon={<ListChecks className="size-5" />} title="No rejected records" />
            ) : (
              <>
                <Table caption="Rejected records">
                  <THead>
                    <tr>
                      <TH className="text-right">Line</TH>
                      <TH>Account reference</TH>
                      <TH>Problem</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {rejections.data.items.map((r) => (
                      <TR key={r.lineNumber}>
                        <TD className="text-right tabular-nums">{integer(r.lineNumber)}</TD>
                        <TD className="font-mono text-xs">
                          {r.accountRef ?? <span className="text-muted">not stored</span>}
                        </TD>
                        <TD>
                          <span className="font-medium">{sentenceCase(r.code)}</span>
                          <span className="text-muted"> · {r.message}</span>
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
                <Pager
                  count={rejections.data.items.length}
                  nextHref={
                    rejections.data.nextCursor
                      ? withQuery(base, query, { cursor: rejections.data.nextCursor })
                      : null
                  }
                  firstHref={query.cursor ? withQuery(base, query, { cursor: null }) : null}
                />
              </>
            )}
          </Card>
        </div>
      </div>

      {proposal || canAsk ? (
        <Card className="mt-6">
          <CardHeader
            title="Why records were rejected"
            description={
              proposal
                ? proposal.summary
                : 'The Eligibility Feed agent explains each kind of rejection and proposes a fix. A programme manager approves every fix.'
            }
            actions={
              canAsk && !proposal ? (
                <AskAgentForm
                  question={`Explain rejections: programme ${p.id}, feed ${f.id}.`}
                  label="Ask the agent to explain"
                />
              ) : undefined
            }
          />
          {proposal && explained?.explanations ? (
            <div className="p-5">
              <ExplanationsForm
                programmeId={p.id}
                proposalId={proposal.id}
                explanations={explained.explanations}
                counts={explained.counts ?? {}}
                canDecide={me.permissions.includes('card:manage')}
              />
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
