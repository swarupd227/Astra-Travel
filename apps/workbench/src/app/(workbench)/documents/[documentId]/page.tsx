import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Download } from 'lucide-react';
import type { z } from 'zod';
import { DOCUMENT_KIND_LABELS, type IssuedDocumentDetailSchema } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { plainReason } from '@/lib/plain-errors';
import { Badge, Card, CardHeader, DescriptionList, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { buttonClass } from '@/components/ui/button';
import { DELIVERY_TONES } from '../tones';

export const metadata = { title: 'Document' };

type Doc = z.infer<typeof IssuedDocumentDetailSchema>;

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('documents:read'))
    return <AccessDenied permission="documents:read" />;
  const { documentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) notFound();
  const res = await load(() => api<Doc>(`/v1/documents/${documentId}`));
  if (res.error instanceof ApiProblem && res.error.problem.code === 'not_found') notFound();
  if (res.error) return <ErrorPanel error={res.error} />;
  const d = res.data;
  const back = d.policyId
    ? { href: `/policies/${d.policyId}`, label: d.policyNumber ?? 'Policy' }
    : { href: '/documents', label: 'Documents' };
  return (
    <>
      <Link
        href={back.href}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {back.label}
      </Link>
      <PageHeader
        eyebrow={d.policyNumber ?? 'Card programme'}
        title={d.title}
        description={
          d.status === 'failed'
            ? 'This document could not be produced.'
            : `${DOCUMENT_KIND_LABELS[d.kind]}. Issued as the policy record stood; it does not change.`
        }
        actions={
          <>
            {me.permissions.includes('audit:read') ? (
              <a href={`/api/trace/documents/${d.id}`} className={buttonClass('ghost')}>
                Audit trace
              </a>
            ) : null}
            {d.status === 'issued' ? (
              <a
                href={`/api/documents/${d.id}/file`}
                className={buttonClass('secondary')}
                target="_blank"
                rel="noreferrer"
              >
                <Download aria-hidden className="size-4" /> Open the PDF
              </a>
            ) : (
              <Badge tone="danger">Failed</Badge>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card className="min-w-0">
          <CardHeader title="Text" description="What the PDF says, in reading order." />
          {d.text ? (
            <pre
              className="max-h-[40rem] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed text-fg"
              tabIndex={0}
              aria-label="Document text"
            >
              {d.text}
            </pre>
          ) : (
            <p className="p-5 text-sm text-danger">{plainReason(d.failure ?? '')}</p>
          )}
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Record" />
            <div className="p-5">
              <DescriptionList
                items={[
                  { term: 'Kind', value: DOCUMENT_KIND_LABELS[d.kind] },
                  { term: 'Issued', value: <LocalTime iso={d.issuedAt} /> },
                  { term: 'Made with', value: d.source ?? '—' },
                  ...(d.version ? [{ term: 'Version', value: String(d.version) }] : []),
                  {
                    term: 'SHA-256',
                    value: <span className="break-all font-mono text-xs">{d.sha256 ?? '—'}</span>,
                  },
                  ...(d.templateId
                    ? [
                        {
                          term: 'Template',
                          value: (
                            <Link
                              className="text-primary hover:underline"
                              href={`/documents/templates/${d.templateId}`}
                            >
                              Open the template
                            </Link>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Delivery" />
            {d.deliveries.length ? (
              <Table caption="Deliveries">
                <THead>
                  <tr>
                    <TH>Channel</TH>
                    <TH>Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {d.deliveries.map((x) => (
                    <TR key={x.id}>
                      <TD>
                        {sentenceCase(x.channel)}
                        {x.recipient ? (
                          <span className="block font-mono text-xs text-muted">{x.recipient}</span>
                        ) : null}
                      </TD>
                      <TD>
                        <Badge tone={DELIVERY_TONES[x.status]}>{sentenceCase(x.status)}</Badge>
                        {x.receipt === 'delivered' ? (
                          <span className="mt-1 block text-xs text-muted">
                            The provider reports it arrived.
                          </span>
                        ) : null}
                        {x.lastError ? (
                          <span className="mt-1 block text-xs text-danger">
                            {plainReason(x.lastError ?? '')}
                          </span>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="p-5 text-sm text-muted">Not delivered: there is no document to send.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
