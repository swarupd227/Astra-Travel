import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type {
  CardProgramme,
  FeedMapping,
  FeedMappingPreview,
  FeedSample,
  Proposal,
} from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { ApproveMappingForm, AskAgentForm, SampleForm } from './forms';

export const metadata = { title: 'Issuer file mapping' };

const EMPTY = {
  delimiter: ',',
  columns: {
    accountRef: { column: '' },
    productCode: { column: '', values: {} },
    action: { constant: 'A' },
    eligibleFrom: { column: '', format: 'YYYY-MM-DD' },
    eligibleTo: null,
  },
};

export default async function MappingPage({
  params,
}: {
  params: Promise<{ programmeId: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('card:read')) return <AccessDenied permission="card:read" />;
  const { programmeId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(programmeId)) notFound();
  const [programme, samples, mappings, proposals] = await Promise.all([
    load(() => api<CardProgramme>(`/v1/card-programmes/${programmeId}`)),
    load(() => api<{ items: FeedSample[] }>(`/v1/card-programmes/${programmeId}/samples`)),
    load(() => api<{ items: FeedMapping[] }>(`/v1/card-programmes/${programmeId}/mappings`)),
    me.permissions.includes('proposals:read')
      ? load(() =>
          api<{ items: Omit<Proposal, 'content'>[] }>('/v1/agent-proposals', {
            query: { subjectId: programmeId, kind: 'feed_mapping', status: 'open' },
          }),
        )
      : Promise.resolve(null),
  ]);
  if (programme.error instanceof ApiProblem && programme.error.problem.code === 'not_found')
    notFound();
  if (programme.error) return <ErrorPanel error={programme.error} />;
  const p = programme.data;
  const sample = samples.data?.items[0];
  const current = mappings.data?.items.find((m) => m.status === 'approved');
  const openId = proposals?.data?.items[0]?.id;
  const proposal = openId
    ? (await load(() => api<Proposal>(`/v1/agent-proposals/${openId}`))).data
    : null;
  const content = proposal?.content as
    { mapping?: unknown; sampleId?: string; preview?: FeedMappingPreview } | undefined;
  const canManage = me.permissions.includes('card:manage');
  const canAsk =
    me.permissions.includes('agents:use') && me.permissions.includes('proposals:create');
  return (
    <>
      <Link
        href={`/card/programmes/${p.id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {p.name}
      </Link>
      <PageHeader
        eyebrow="Eligibility feeds"
        title="Issuer file mapping"
        description="How the issuer’s file is read. The agent can draft it; a programme manager approves it."
        actions={
          current ? (
            <Badge tone="success">Version {current.version} in use</Badge>
          ) : (
            <Badge tone="warning">No mapping yet</Badge>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Sample of the issuer’s file"
              description={sample ? `${sample.fileName}, ${sample.lines} lines` : 'None yet'}
            />
            <div className="space-y-4 p-5">
              {sample ? (
                <>
                  <pre
                    className="max-h-48 overflow-auto rounded-lg bg-surface-muted p-3 text-xs"
                    tabIndex={0}
                    aria-label="The first lines of the sample"
                  >
                    {sample.text.split('\n').slice(0, 15).join('\n')}
                  </pre>
                  {canAsk ? (
                    <AskAgentForm
                      question={`Map the issuer file: programme ${p.id}, sample ${sample.id}.`}
                      label="Ask the agent to draft a mapping"
                    />
                  ) : null}
                </>
              ) : null}
              {me.permissions.includes('card:feeds') ? <SampleForm programmeId={p.id} /> : null}
            </div>
          </Card>
          {current ? (
            <Card>
              <CardHeader
                title={`In use: version ${current.version}`}
                description={<LocalTime iso={current.approvedAt} />}
              />
              <pre
                className="max-h-72 overflow-auto p-5 text-xs"
                tabIndex={0}
                aria-label="The mapping in use"
              >
                {JSON.stringify(current.document, null, 2)}
              </pre>
            </Card>
          ) : null}
        </div>
        <div className="space-y-6 lg:col-span-2">
          {proposal && content?.preview ? (
            <Card>
              <CardHeader title="The agent’s proposal" description={proposal.summary} />
              <div className="space-y-4 p-5">
                <Notice
                  tone={content.preview.rejected ? 'warning' : 'success'}
                  title={`${content.preview.converted} of ${content.preview.records} sample records convert`}
                >
                  {content.preview.problems.length
                    ? content.preview.problems
                        .slice(0, 5)
                        .map((x) => `Line ${x.line}: ${x.message}`)
                        .join(' ')
                    : 'No record is rejected.'}
                </Notice>
                <Table caption="Sample records as they would be read">
                  <THead>
                    <tr>
                      <TH className="text-right">Line</TH>
                      <TH>Account reference</TH>
                      <TH>Product</TH>
                      <TH>Action</TH>
                      <TH>From</TH>
                      <TH>To</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {content.preview.sample.map((r) => (
                      <TR key={r.line}>
                        <TD className="text-right tabular-nums">{r.line}</TD>
                        <TD className="font-mono text-xs">{r.accountRef}</TD>
                        <TD>{r.productCode}</TD>
                        <TD>{r.action}</TD>
                        <TD>{r.eligibleFrom}</TD>
                        <TD>{r.eligibleTo ?? '—'}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
                {canManage ? (
                  <ApproveMappingForm
                    programmeId={p.id}
                    sampleId={content.sampleId!}
                    proposalId={proposal.id}
                    initial={JSON.stringify(content.mapping, null, 2)}
                    label="Approve this mapping"
                  />
                ) : null}
              </div>
            </Card>
          ) : sample && canManage ? (
            <Card>
              <CardHeader
                title={current ? 'Change the mapping' : 'Write the mapping'}
                description="Or ask the agent to draft it."
              />
              <div className="p-5">
                <ApproveMappingForm
                  programmeId={p.id}
                  sampleId={sample.id}
                  initial={JSON.stringify(current?.document ?? EMPTY, null, 2)}
                  label="Approve as a new version"
                />
              </div>
            </Card>
          ) : (
            <Card>
              <p className="p-5 text-sm text-muted">
                Keep a sample of the issuer’s file to draft a mapping.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
