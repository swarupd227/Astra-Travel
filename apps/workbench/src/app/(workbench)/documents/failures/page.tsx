import Link from 'next/link';
import { CheckCircle2, ChevronLeft } from 'lucide-react';
import type { FailedDeliverySchema, IssuedDocument } from '@astra/contracts';
import type { z } from 'zod';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { IssueMissingForm, RetryDeliveryForm } from '../document-forms';

export const metadata = { title: 'Failed documents and deliveries' };

type Failures = { documents: IssuedDocument[]; deliveries: z.infer<typeof FailedDeliverySchema>[] };

export default async function FailuresPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('documents:read'))
    return <AccessDenied permission="documents:read" />;
  const res = await load(() => api<Failures>('/v1/document-failures'));
  if (res.error) return <ErrorPanel error={res.error} />;
  const { documents, deliveries } = res.data;
  const canManage = me.permissions.includes('documents:manage');
  return (
    <>
      <Link
        href="/documents"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Document templates
      </Link>
      <PageHeader
        eyebrow="Documents"
        title="Failed documents and deliveries"
        description="Documents that could not be produced when a policy was bound, and emails that could not be sent after every attempt. Nothing here is hidden from the traveller’s policy record: it shows the document as failed."
      />
      {documents.length === 0 && deliveries.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CheckCircle2 className="size-5" />}
            title="Nothing has failed"
            description="Every document was produced and every delivery that was tried has gone out or is still being tried."
          />
        </Card>
      ) : null}
      {documents.length ? (
        <Card className="mb-6">
          <CardHeader
            title="Documents not produced"
            description="Usually the plan version has no released template. Release one, then issue the documents again."
          />
          <Table caption="Documents not produced">
            <THead>
              <tr>
                <TH>Policy</TH>
                <TH>Document</TH>
                <TH>Why</TH>
                <TH>
                  <span className="sr-only">Action</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {documents.map((d) => (
                <TR key={d.id}>
                  <TD>
                    {d.policyId ? (
                      <Link
                        href={`/policies/${d.policyId}`}
                        className="font-medium text-fg hover:text-primary hover:underline"
                      >
                        {d.policyNumber}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD>{sentenceCase(d.kind)}</TD>
                  <TD className="max-w-md text-sm">{d.failure}</TD>
                  <TD>
                    {canManage && d.policyId ? (
                      <IssueMissingForm policyId={d.policyId} label="Issue again" />
                    ) : null}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      {deliveries.length ? (
        <Card>
          <CardHeader
            title="Emails not delivered"
            description="Each was tried several times with waits between. The reason is the mail server’s or the platform’s own answer."
          />
          <Table caption="Failed email deliveries">
            <THead>
              <tr>
                <TH>Policy</TH>
                <TH>Document</TH>
                <TH>To</TH>
                <TH>Attempts</TH>
                <TH>Last error</TH>
                <TH>
                  <span className="sr-only">Action</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {deliveries.map((d) => (
                <TR key={d.id}>
                  <TD>{d.policyNumber ?? '—'}</TD>
                  <TD>
                    <Link
                      href={`/documents/${d.documentId}`}
                      className="text-fg hover:text-primary hover:underline"
                    >
                      {sentenceCase(d.documentKind)}
                    </Link>
                  </TD>
                  <TD className="font-mono text-xs">{d.recipient}</TD>
                  <TD>{d.attempts}</TD>
                  <TD className="max-w-md text-sm">{d.lastError}</TD>
                  <TD>{canManage ? <RetryDeliveryForm deliveryId={d.id} /> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
