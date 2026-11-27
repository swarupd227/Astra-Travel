import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { PROPOSAL_KIND_LABELS, type FormVariableInput, type Proposal } from '@astra/contracts';
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
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { FindingsReview } from '../../documents/document-forms';
import { OnboardingReview, type OnboardingItem } from '../onboarding-review';
import {
  CloseProposalForm,
  ManualReview,
  MarkReviewedForm,
  VariableReview,
  type ManualTable,
  type VariableItem,
} from '../proposal-forms';

export const metadata = { title: 'Agent proposal' };

type Check = { item: string; ok: boolean; detail: string };
const ONBOARDING_FIELD_LABELS: Record<string, string> = {
  contractReference: 'Contract reference',
  contractSignedOn: 'Contract signed on',
  states: 'States the account sells in',
  plans: 'Plans',
  integrationMethod: 'Integration method',
  rateBasis: 'Billing basis (JSON)',
  settlement: 'Settlement terms (JSON)',
  segment: 'Business segment',
  notCollected: 'Rating variables not collected',
};

export default async function ProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ proposalId: string }>;
  searchParams: Promise<{ done?: string; map?: string; manual?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('proposals:read'))
    return <AccessDenied permission="proposals:read" />;
  const { proposalId } = await params;
  const { done, map, manual } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(proposalId)) notFound();
  const res = await load(() => api<Proposal>(`/v1/agent-proposals/${proposalId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const p = res.data;
  // Feed proposals are judged where the programme manager works with the feed.
  if (p.kind === 'feed_mapping') redirect(`/card/programmes/${p.subjectId}/mapping`);
  if (p.kind === 'feed_rejections')
    redirect(
      `/card/programmes/${String((p.content as { programmeId?: string }).programmeId)}/feeds/${p.subjectId}`,
    );
  const names = await peopleNames([p.requestedBy, p.resolvedBy]);
  const open = p.status === 'open';
  const canManage = me.permissions.includes(
    p.kind === 'variable_map'
      ? 'forms:manage'
      : p.kind === 'document_quality'
        ? 'documents:release'
        : p.kind === 'account_onboarding'
          ? 'accounts:manage'
          : 'rating:manage',
  );
  const checks = new Map((p.verification as Check[]).map((c) => [c.item, c]));
  const content = p.content as {
    items?: {
      variable?: FormVariableInput;
      rationale?: string;
      caseId?: string;
      step?: string;
      explanation?: string;
      manualPage?: string;
      workbookCell?: { row: number; column: string };
    }[];
    manual?: {
      code: string;
      state: string;
      benefit: string;
      effectiveFrom: string;
      document: { tables: { id: string; name: string; page: string; rows: unknown[] }[] };
    };
    uncertainties?: string[];
    findings?: { quote: string; issue: string; severity?: 'hold' | 'note' }[];
    fields?: {
      field: string;
      value: unknown;
      documentId: string;
      excerpt: string;
      note?: string;
    }[];
  };

  const back =
    p.subjectType === 'account'
      ? { href: `/accounts/${p.subjectId}/setup`, label: 'Account setup' }
      : p.subjectType === 'document_template'
        ? { href: `/documents/templates/${p.subjectId}`, label: 'Document template' }
        : p.subjectType === 'document'
          ? { href: `/documents/${p.subjectId}`, label: 'Document' }
          : p.subjectType === 'rate_manual'
            ? { href: `/rating/manuals/${p.subjectId}`, label: 'Rate manual' }
            : {
                href: `/forms/${p.subjectId}`,
                label: p.kind === 'variable_map' ? 'Form edition' : 'Rate manual document',
              };

  const accountDocs =
    p.kind === 'account_onboarding'
      ? await load(() =>
          api<{ items: { id: string; fileName: string }[] }>(
            `/v1/accounts/${p.subjectId}/documents`,
          ),
        )
      : null;
  const docName = (id: string) =>
    accountDocs?.data?.items.find((d) => d.id === id)?.fileName ?? 'the document';
  const edition =
    p.subjectType === 'form_edition'
      ? await load(() =>
          api<{ formNumber: string; edition: string; title: string; pageCount: number }>(
            `/v1/form-editions/${p.subjectId}`,
          ),
        )
      : null;
  const text =
    p.kind === 'variable_map'
      ? await load(() =>
          api<{ text: string; pageStarts: number[] }>(`/v1/form-editions/${p.subjectId}/text`),
        )
      : null;
  const pageOf = (offset: number) =>
    text?.data ? text.data.pageStarts.filter((s) => s <= offset).length || 1 : null;

  return (
    <>
      <Link
        href={back.href}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {back.label}
      </Link>
      <PageHeader
        eyebrow={`${p.agentName} (${p.agentId})`}
        title={PROPOSAL_KIND_LABELS[p.kind]}
        description={p.summary}
        actions={
          <Badge tone={open ? 'warning' : p.status === 'resolved' ? 'success' : 'neutral'}>
            {sentenceCase(p.status)}
          </Badge>
        }
      />
      <div className="mb-6 space-y-3">
        {done === 'applied' ? (
          <Notice tone="success" title="Variables saved">
            The accepted variables are in the edition’s draft map.{' '}
            {map ? (
              <Link
                className="font-medium text-primary hover:underline"
                href={`/forms/${p.subjectId}`}
              >
                Open the map
              </Link>
            ) : null}{' '}
            Someone else approves it.
          </Notice>
        ) : null}
        {done === 'loaded' ? (
          <Notice tone="success" title="Draft manual loaded">
            <Link
              className="font-medium text-primary hover:underline"
              href={`/rating/manuals/${manual}`}
            >
              Open the draft manual
            </Link>
            . A second analyst approves it, and it is published only after it is filed and every
            parity case matches.
          </Notice>
        ) : null}
        {done === 'onboarding' ? (
          <Notice tone="success" title="Applied">
            The fields you ticked were saved through the ordinary checks.{' '}
            <Link
              className="font-medium text-primary hover:underline"
              href={`/accounts/${p.subjectId}/setup`}
            >
              Open the account setup
            </Link>
          </Notice>
        ) : null}
        {done === 'rejected' ? (
          <Notice tone="neutral" title="Proposal rejected">
            Nothing was saved. The decision is recorded for the agent’s review.
          </Notice>
        ) : null}
        {done === 'reviewed' ? (
          <Notice tone="success" title="Marked as reviewed">
            The review is recorded.
          </Notice>
        ) : null}
        <Notice tone="neutral" title="Proposed by an agent, not saved">
          {p.agentName} read{' '}
          {edition?.data ? `${edition.data.formNumber} (${edition.data.edition})` : 'the records'}{' '}
          for {nameOf(names, p.requestedBy)}. Nothing is saved until you apply it, and what you
          apply goes through the same checks and approvals as anything you type. The checks below
          are the platform’s own, made against the document, not the agent’s say-so.
        </Notice>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="min-w-0">
          <CardHeader
            title={
              p.kind === 'variable_map'
                ? 'Proposed variables'
                : p.kind === 'rate_manual'
                  ? 'Drafted manual'
                  : p.kind === 'document_quality'
                    ? 'Findings'
                    : p.kind === 'account_onboarding'
                      ? 'Drafted onboarding fields'
                      : 'Differences explained'
            }
          />
          <div className="space-y-4 p-5">
            {p.kind === 'variable_map' ? (
              canManage || !open ? (
                <VariableReview
                  proposalId={p.id}
                  editionId={p.subjectId}
                  open={open && canManage}
                  items={(content.items ?? []).map<VariableItem>((i) => ({
                    variable: i.variable!,
                    rationale: i.rationale ?? '',
                    page: pageOf(i.variable!.textStart),
                    check: checks.get(i.variable!.key) ?? null,
                  }))}
                />
              ) : (
                <Notice tone="neutral">
                  You need the forms:manage permission to apply this proposal.
                </Notice>
              )
            ) : null}
            {p.kind === 'rate_manual' && content.manual ? (
              <>
                {content.uncertainties?.length ? (
                  <Notice tone="warning" title="The agent could not read or was unsure of">
                    <ul className="list-disc pl-5">
                      {content.uncertainties.map((u) => (
                        <li key={u}>{u}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}
                <ManualReview
                  proposalId={p.id}
                  open={open && canManage}
                  manual={content.manual}
                  source={
                    edition?.data
                      ? `${edition.data.formNumber} edition ${edition.data.edition}`
                      : 'Filed rate manual'
                  }
                  tables={content.manual.document.tables.map<ManualTable>((t) => ({
                    id: t.id,
                    name: t.name,
                    page: t.page,
                    rows: t.rows.length,
                    ok: checks.get(t.id)?.ok ?? null,
                    detail: checks.get(t.id)?.detail ?? '',
                  }))}
                />
              </>
            ) : null}
            {p.kind === 'account_onboarding' ? (
              <OnboardingReview
                proposalId={p.id}
                accountId={p.subjectId}
                open={open && canManage}
                items={(content.fields ?? []).map<OnboardingItem>((f) => ({
                  field: f.field,
                  label: ONBOARDING_FIELD_LABELS[f.field] ?? f.field,
                  value: Array.isArray(f.value)
                    ? f.value.join(', ')
                    : typeof f.value === 'object' && f.value !== null
                      ? JSON.stringify(f.value)
                      : String(f.value),
                  documentName: docName(f.documentId),
                  excerpt: f.excerpt,
                  note: f.note ?? null,
                }))}
              />
            ) : null}
            {p.kind === 'document_quality' ? (
              open && canManage ? (
                <FindingsReview
                  proposalId={p.id}
                  items={(content.findings ?? []).map((f, i) => ({
                    id: `f${i + 1}`,
                    quote: f.quote,
                    issue: f.issue,
                    severity: f.severity ?? 'hold',
                  }))}
                />
              ) : (
                <>
                  {(content.findings ?? []).length === 0 ? (
                    <p className="text-sm text-muted">The agent found nothing wrong.</p>
                  ) : null}
                  <ul className="space-y-3">
                    {(content.findings ?? []).map((f, i) => {
                      const accepted = (
                        (p.resolution?.accepted as string[] | undefined) ?? []
                      ).includes(`f${i + 1}`);
                      return (
                        <li key={i} className="rounded-lg border border-border p-3 text-sm">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-fg">{f.issue}</span>
                            {p.status === 'resolved' ? (
                              <Badge tone={accepted ? 'danger' : 'neutral'}>
                                {accepted ? 'Accepted as a defect' : 'Not an issue'}
                              </Badge>
                            ) : (
                              <Badge tone="warning">
                                {f.severity === 'note' ? 'Note' : 'Holds release'}
                              </Badge>
                            )}
                          </span>
                          <span className="mt-1 block text-muted">
                            Quoted: <q className="font-mono text-xs text-fg">{f.quote}</q>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {open && !canManage ? (
                    <Notice tone="neutral">
                      You need the documents:release permission to review these findings.
                    </Notice>
                  ) : null}
                </>
              )
            ) : null}
            {p.kind === 'parity_explanation' ? (
              <>
                <Table caption="Parity differences explained">
                  <THead>
                    <tr>
                      <TH>Case and step</TH>
                      <TH>Explanation</TH>
                      <TH>Cited</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {(content.items ?? []).map((i) => {
                      const c = (p.verification as Check[]).find(
                        (x) => x.item.endsWith(`/ ${i.step}`) && true,
                      );
                      return (
                        <TR key={`${i.caseId}:${i.step}`}>
                          <TD className="font-mono text-xs">
                            {c?.item ?? i.step}
                            <span className="mt-1 block font-sans text-muted">{c?.detail}</span>
                          </TD>
                          <TD className="max-w-md text-sm">{i.explanation}</TD>
                          <TD className="text-xs">
                            Manual page <span className="font-mono">{i.manualPage}</span>
                            <br />
                            Workbook row {i.workbookCell?.row},{' '}
                            <span className="font-mono">{i.workbookCell?.column}</span>
                          </TD>
                        </TR>
                      );
                    })}
                  </tbody>
                </Table>
                {open && canManage ? (
                  <MarkReviewedForm
                    proposalId={p.id}
                    items={(content.items ?? []).map((i) => `${i.caseId}:${i.step}`)}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Record" />
            <div className="p-5">
              <DescriptionList
                items={[
                  { term: 'Agent', value: `${p.agentName} (${p.agentId})` },
                  { term: 'Asked by', value: nameOf(names, p.requestedBy) },
                  { term: 'Proposed', value: <LocalTime iso={p.createdAt} /> },
                  ...(p.status !== 'open' && p.resolvedBy
                    ? [{ term: 'Resolved by', value: nameOf(names, p.resolvedBy) }]
                    : []),
                  ...(p.resolution && 'accepted' in p.resolution
                    ? [
                        {
                          term: 'Accepted',
                          value: String((p.resolution.accepted as string[]).length),
                        },
                        {
                          term: 'Corrected',
                          value: String((p.resolution.corrected as string[]).length),
                        },
                        {
                          term: 'Rejected',
                          value: String((p.resolution.rejected as string[]).length),
                        },
                      ]
                    : []),
                ]}
              />
              {p.runId ? (
                <p className="mt-3 text-xs">
                  <Link
                    className="text-primary hover:underline"
                    href={`/governance/agents/${p.agentId}`}
                  >
                    Agent and its run log
                  </Link>
                </p>
              ) : null}
            </div>
          </Card>
          {open &&
          canManage &&
          p.kind !== 'parity_explanation' &&
          p.kind !== 'document_quality' &&
          p.kind !== 'account_onboarding' ? (
            <Card>
              <CardHeader
                title="Not useful?"
                description="Rejecting records that nothing was taken from it."
              />
              <div className="p-5">
                <CloseProposalForm
                  proposalId={p.id}
                  items={
                    p.kind === 'variable_map'
                      ? (content.items ?? []).map((i) => i.variable!.key)
                      : (content.manual?.document.tables ?? []).map((t) => t.id)
                  }
                />
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
