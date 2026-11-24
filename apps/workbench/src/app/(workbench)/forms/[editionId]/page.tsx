import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Download, ListTree } from 'lucide-react';
import type {
  BracketSpan,
  FormEdition,
  RefdataDatasetSummary,
  VariableMap,
} from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { nameOf, peopleNames } from '@/lib/people';
import { bytes, FILING_STATUS_TONES, filingInForce, sentenceCase } from '@/lib/format';
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
import { RecordFilingDialog } from '../../compliance/filings/filing-forms';
import { UsabilityCheck } from '../form-forms';
import { MapWorkspace } from './map-workspace';

export const metadata = { title: 'Form edition' };

export default async function EditionPage({
  params,
  searchParams,
}: {
  params: Promise<{ editionId: string }>;
  searchParams: Promise<{ loaded?: string; approved?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('forms:read')) return <AccessDenied permission="forms:read" />;
  const { editionId } = await params;
  const { loaded, approved } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(editionId)) notFound();

  const edition = await load(() => api<FormEdition>(`/v1/form-editions/${editionId}`));
  if (edition.error instanceof ApiProblem && edition.error.problem.code === 'not_found') notFound();
  if (edition.error) return <ErrorPanel error={edition.error} />;
  const e = edition.data;
  const [text, brackets, draft, current, datasets] = await Promise.all([
    load(() => api<{ text: string; pageStarts: number[] }>(`/v1/form-editions/${editionId}/text`)),
    load(() => api<{ items: BracketSpan[] }>(`/v1/form-editions/${editionId}/brackets`)),
    e.draftMap ? load(() => api<VariableMap>(`/v1/variable-maps/${e.draftMap!.id}`)) : null,
    e.currentMap ? load(() => api<VariableMap>(`/v1/variable-maps/${e.currentMap!.id}`)) : null,
    me.permissions.includes('refdata:read')
      ? load(() => api<{ items: RefdataDatasetSummary[] }>('/v1/reference-data'))
      : null,
  ]);
  if (text.error) return <ErrorPanel error={text.error} />;
  const today = new Date().toISOString().slice(0, 10);
  const names = await peopleNames([
    e.createdBy,
    ...(draft?.data?.contributors ?? []),
    current?.data?.approvedBy,
  ]);
  const canFile = me.permissions.includes('filings:manage');

  return (
    <>
      <Link
        href="/forms"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Forms & schedules
      </Link>
      <PageHeader
        eyebrow={`${sentenceCase(e.kind)} · ${e.insurer}`}
        title={e.title}
        description={
          <>
            <span className="font-mono">{e.formNumber}</span>, edition {e.edition}
          </>
        }
        actions={
          <>
            {e.kind === 'schedule' ? (
              <Link
                href={`/forms/${e.id}/catalogue`}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-contrast shadow-card hover:bg-primary-hover"
              >
                <ListTree aria-hidden className="size-4" /> Benefit catalogue
              </Link>
            ) : null}
            <a
              href={`/forms/${e.id}/document`}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium text-fg shadow-card hover:bg-surface-muted"
            >
              <Download aria-hidden className="size-4" /> Filed document
            </a>
          </>
        }
      />
      <div className="mb-6 space-y-3">
        {loaded ? (
          <Notice tone="success" title="Edition loaded">
            {e.pageCount} page{e.pageCount === 1 ? '' : 's'} of text were read. Record its filings
            by state, then build its variable map.
          </Notice>
        ) : null}
        {approved ? (
          <Notice tone="success" title="Variable map approved">
            It is now the edition&rsquo;s current map; plans are built from it.
          </Notice>
        ) : null}
        {e.textLength === 0 ? (
          <Notice tone="warning">No text was found in this document.</Notice>
        ) : null}
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Edition" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'File', value: e.fileName },
                { term: 'Size', value: bytes(e.sizeBytes) },
                { term: 'Pages', value: e.pageCount },
                {
                  term: 'SHA-256',
                  value: <span className="break-all font-mono text-xs">{e.sha256}</span>,
                },
                { term: 'Loaded', value: <LocalTime iso={e.createdAt} /> },
                { term: 'Loaded by', value: nameOf(names, e.createdBy) },
              ]}
            />
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Filings by state"
            description="A plan can use this edition in a state only while an approved filing is in effect there."
            actions={
              canFile ? (
                <RecordFilingDialog
                  editions={[
                    {
                      id: e.id,
                      insurer: e.insurer,
                      label: `${e.formNumber} ed. ${e.edition} · ${e.title}`,
                    },
                  ]}
                  presetEditionId={e.id}
                />
              ) : null
            }
          />
          {e.filings.length === 0 ? (
            <EmptyState
              title="No filings recorded"
              description="Record where this edition is filed and approved."
            />
          ) : (
            <Table caption="Filings for this edition">
              <THead>
                <tr>
                  <TH>State</TH>
                  <TH>Status</TH>
                  <TH>Effective</TH>
                  <TH>SERFF</TH>
                  <TH>In effect today</TH>
                </tr>
              </THead>
              <tbody>
                {e.filings.map((f) => (
                  <TR key={f.id}>
                    <TD>
                      <Link
                        href={`/compliance/filings/${f.id}`}
                        className="font-mono text-xs font-medium text-fg hover:text-primary hover:underline"
                      >
                        {f.state}
                      </Link>
                    </TD>
                    <TD>
                      <Badge tone={FILING_STATUS_TONES[f.status]}>{sentenceCase(f.status)}</Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-muted">
                      {f.effectiveFrom
                        ? `${f.effectiveFrom}${f.effectiveTo ? ` to ${f.effectiveTo}` : ''}`
                        : '—'}
                    </TD>
                    <TD className="font-mono text-xs text-muted">{f.serffTracking ?? '—'}</TD>
                    <TD>
                      {filingInForce(f, today) ? (
                        <Badge tone="success">Yes</Badge>
                      ) : (
                        <span className="text-muted">No</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
          <div className="border-t border-border">
            <p className="px-5 pt-4 text-sm font-medium text-fg">Can a plan use it?</p>
            <UsabilityCheck editionId={e.id} />
          </div>
        </Card>
      </div>

      <MapWorkspace
        editionId={e.id}
        text={text.data.text}
        pageStarts={text.data.pageStarts}
        brackets={brackets.data?.items ?? []}
        draft={draft?.data ?? null}
        current={current?.data ?? null}
        canEdit={me.permissions.includes('forms:manage')}
        me={me.subject}
        names={names}
        datasets={(datasets?.data?.items ?? []).map((d) => ({ code: d.code, name: d.name }))}
      />
    </>
  );
}
