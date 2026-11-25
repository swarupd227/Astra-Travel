import Link from 'next/link';
import { Download } from 'lucide-react';
import type { IssuedDocument } from '@astra/contracts';
import { DOCUMENT_KIND_LABELS } from '@astra/contracts';
import { api } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { load } from '@/components/error-panel';
import { buttonClass } from '@/components/ui/button';
import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { IssueMissingForm } from './document-forms';
import { DELIVERY_TONES } from './tones';

/** The documents issued for a policy, how each was delivered, and the PDFs. */
export async function PolicyDocuments({ policyId, canManage }: { policyId: string; canManage: boolean }) {
  const res = await load(() => api<{ items: IssuedDocument[] }>(`/v1/policies/${policyId}/documents`));
  if (res.error) return null;
  const docs = res.data.items;
  const needAttention = docs.some((d) => d.status === 'failed') || !docs.some((d) => d.kind === 'purchase_confirmation');
  return (
    <Card className="mb-6">
      <CardHeader title="Documents" description="Issued when the policy was bound. Each is kept exactly as issued, with its PDF and hash." actions={canManage && needAttention ? <IssueMissingForm policyId={policyId} /> : null} />
      {docs.length === 0 ? (
        <p className="p-5 text-sm text-muted">No documents have been issued for this policy.</p>
      ) : (
        <Table caption="Documents">
          <THead>
            <tr>
              <TH>Document</TH>
              <TH>Status</TH>
              <TH>Delivery</TH>
              <TH>Issued</TH>
              <TH>
                <span className="sr-only">PDF</span>
              </TH>
            </tr>
          </THead>
          <tbody>
            {docs.map((d) => (
              <TR key={d.id}>
                <TD>
                  <Link href={`/documents/${d.id}`} className="font-medium text-fg hover:text-primary hover:underline">
                    {DOCUMENT_KIND_LABELS[d.kind]}
                  </Link>
                  {d.status === 'failed' ? <span className="block max-w-sm text-xs text-danger">{d.failure}</span> : null}
                </TD>
                <TD>
                  <Badge tone={d.status === 'issued' ? 'success' : 'danger'}>{sentenceCase(d.status)}</Badge>
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    {d.deliveries.map((x) => (
                      <Badge key={x.id} tone={DELIVERY_TONES[x.status]}>
                        {sentenceCase(x.channel)}: {x.status}
                      </Badge>
                    ))}
                    {d.deliveries.length === 0 ? <span className="text-xs text-muted">—</span> : null}
                  </span>
                </TD>
                <TD className="whitespace-nowrap text-muted">
                  <LocalTime iso={d.issuedAt} />
                </TD>
                <TD className="text-right">
                  {d.status === 'issued' ? (
                    <a href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer" className={buttonClass('ghost', 'sm')} aria-label={`Open the PDF of the ${DOCUMENT_KIND_LABELS[d.kind].toLowerCase()}`}>
                      <Download aria-hidden className="size-3.5" /> PDF
                    </a>
                  ) : null}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
