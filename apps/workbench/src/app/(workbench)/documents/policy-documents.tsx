import Link from 'next/link';
import { Download, FileText, FileWarning } from 'lucide-react';
import type { IssuedDocument } from '@astra/contracts';
import { DOCUMENT_KIND_LABELS } from '@astra/contracts';
import { api } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { load } from '@/components/error-panel';
import { plainReason } from '@/lib/plain-errors';
import { buttonClass } from '@/components/ui/button';
import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { IssueMissingForm } from './document-forms';
import { DELIVERY_TONES } from './tones';

/** The documents issued for a policy, how each was delivered, and the PDFs. */
export async function PolicyDocuments({
  policyId,
  canManage,
}: {
  policyId: string;
  canManage: boolean;
}) {
  const res = await load(() =>
    api<{ items: IssuedDocument[] }>(`/v1/policies/${policyId}/documents`),
  );
  if (res.error) return null;
  const docs = res.data.items;
  const needAttention =
    docs.some((d) => d.status === 'failed') ||
    !docs.some((d) => d.kind === 'purchase_confirmation');
  return (
    <Card aria-labelledby="policy-documents">
      <CardHeader
        titleId="policy-documents"
        title="Documents"
        description="Each is kept exactly as it was issued."
        actions={canManage && needAttention ? <IssueMissingForm policyId={policyId} /> : null}
      />
      {docs.length === 0 ? (
        <p className="p-5 text-sm text-muted">No documents have been issued for this policy.</p>
      ) : (
        <ul className="divide-y divide-border">
          {docs.map((d) => {
            const failed = d.status === 'failed';
            const Icon = failed ? FileWarning : FileText;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                <Icon
                  aria-hidden
                  className={failed ? 'size-5 shrink-0 text-danger' : 'size-5 shrink-0 text-muted'}
                />
                <span className="min-w-44 flex-1">
                  <Link
                    href={`/documents/${d.id}`}
                    className="text-sm font-medium text-fg hover:text-primary hover:underline"
                  >
                    {DOCUMENT_KIND_LABELS[d.kind]}
                  </Link>
                  <span className="block text-xs text-muted">
                    {failed ? 'Not issued' : 'Issued'} <LocalTime iso={d.issuedAt} />
                  </span>
                  {failed ? (
                    <span className="block text-xs text-danger">
                      {plainReason(d.failure ?? '')}
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-wrap gap-1">
                  {failed ? <Badge tone="danger">Failed</Badge> : null}
                  {d.deliveries.map((x) => (
                    <Badge key={x.id} tone={DELIVERY_TONES[x.status]}>
                      {sentenceCase(x.channel)}: {x.status}
                    </Badge>
                  ))}
                </span>
                {failed ? null : (
                  <a
                    href={`/api/documents/${d.id}/file`}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonClass('secondary', 'sm')}
                    aria-label={`Open the PDF of the ${DOCUMENT_KIND_LABELS[d.kind].toLowerCase()}`}
                  >
                    <Download aria-hidden className="size-3.5" /> PDF
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
