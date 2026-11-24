import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { Filing } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { nameOf, peopleNames } from '@/lib/people';
import { FILING_ITEM_LABELS, FILING_STATUS_TONES, filingInForce, sentenceCase } from '@/lib/format';
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
import { FilingStatusDialog } from '../filing-forms';

export const metadata = { title: 'Filing' };

type FilingDetail = Filing & {
  history: {
    at: string;
    actor: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
  }[];
};

export default async function FilingPage({
  params,
  searchParams,
}: {
  params: Promise<{ filingId: string }>;
  searchParams: Promise<{ created?: string; changed?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('filings:read')) return <AccessDenied permission="filings:read" />;
  const { filingId } = await params;
  const { created, changed } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(filingId)) notFound();
  const result = await load(() => api<FilingDetail>(`/v1/filings/${filingId}`));
  if (result.error instanceof ApiProblem && result.error.problem.code === 'not_found') notFound();
  if (result.error) return <ErrorPanel error={result.error} />;
  const f = result.data;
  const today = new Date().toISOString().slice(0, 10);
  const names = await peopleNames([f.createdBy, ...f.history.map((h) => h.actor)]);

  return (
    <>
      <Link
        href="/compliance/filings"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Filing register
      </Link>
      <PageHeader
        eyebrow={`${FILING_ITEM_LABELS[f.itemType]} · ${f.state}`}
        title={f.itemReference}
        description={f.serffTracking ? `SERFF ${f.serffTracking}` : 'No SERFF tracking number yet'}
        actions={
          <>
            <Badge tone={FILING_STATUS_TONES[f.status]}>{sentenceCase(f.status)}</Badge>
            {me.permissions.includes('filings:manage') ? (
              <FilingStatusDialog filingId={f.id} current={f.status} serff={f.serffTracking} />
            ) : null}
          </>
        }
      />
      <div className="mb-6 space-y-3">
        {created ? (
          <Notice tone="success" title="Filing recorded">
            It is in draft. Record the submission when it is filed with the state.
          </Notice>
        ) : null}
        {changed ? (
          <Notice tone="success" title={`Filing ${changed}`}>
            Recorded in the history below.
          </Notice>
        ) : null}
        <Notice
          tone={filingInForce(f, today) ? 'success' : 'neutral'}
          title={filingInForce(f, today) ? 'In effect today' : 'Not in effect today'}
        >
          {f.itemType === 'form_edition' && f.itemId ? (
            <>
              Plans may use this edition in {f.state} only while an approved filing is in effect.{' '}
              <Link className="font-medium text-primary underline" href={`/forms/${f.itemId}`}>
                Open the edition
              </Link>
            </>
          ) : (
            `Only an approved filing in effect allows use in ${f.state}.`
          )}
        </Notice>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Filing" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'State', value: f.state },
                { term: 'Insurer', value: f.insurer },
                { term: 'Submitted', value: f.submittedOn ?? '—' },
                { term: 'Decided', value: f.decidedOn ?? '—' },
                { term: 'Effective from', value: f.effectiveFrom ?? '—' },
                {
                  term: 'Effective to',
                  value: f.effectiveTo ?? (f.effectiveFrom ? 'Open-ended' : '—'),
                },
                { term: 'Recorded by', value: nameOf(names, f.createdBy) },
                ...(f.notes ? [{ term: 'Notes', value: f.notes }] : []),
              ]}
            />
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="History" />
          <Table caption="Filing history">
            <THead>
              <tr>
                <TH>When</TH>
                <TH>Change</TH>
                <TH>By</TH>
                <TH>Reason</TH>
              </tr>
            </THead>
            <tbody>
              {f.history.map((h, i) => (
                <TR key={i}>
                  <TD className="whitespace-nowrap text-muted">
                    <LocalTime iso={h.at} />
                  </TD>
                  <TD>
                    {h.fromStatus
                      ? `${sentenceCase(h.fromStatus)} → ${sentenceCase(h.toStatus)}`
                      : 'Recorded'}
                  </TD>
                  <TD className="text-muted">{nameOf(names, h.actor)}</TD>
                  <TD className="text-muted">{h.reason ?? '—'}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
