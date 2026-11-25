import Link from 'next/link';
import { FileText, TriangleAlert } from 'lucide-react';
import type { IssuedDocument, FailedDeliverySchema, TemplateSummarySchema } from '@astra/contracts';
import type { z } from 'zod';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { nameOf, peopleNames } from '@/lib/people';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { TEMPLATE_TONES } from './tones';

export const metadata = { title: 'Document templates' };

type Summary = z.infer<typeof TemplateSummarySchema>;
type Failures = { documents: IssuedDocument[]; deliveries: z.infer<typeof FailedDeliverySchema>[] };

export default async function DocumentsPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('documents:read')) return <AccessDenied permission="documents:read" />;
  const [res, failures] = await Promise.all([load(() => api<{ items: Summary[] }>('/v1/document-templates')), load(() => api<Failures>('/v1/document-failures'))]);
  if (res.error) return <ErrorPanel error={res.error} />;
  const items = res.data.items;
  const names = await peopleNames(items.flatMap((i) => [i.createdBy, i.releasedBy]));
  const failed = failures.data ? failures.data.documents.length + failures.data.deliveries.length : 0;
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Document templates"
        description="A template is a plan version’s schedule or policy assembled from the filed form and the plan’s values. Policies are issued with the released template; assemble one from the plan version’s page."
        actions={
          <ButtonLink href="/documents/failures" variant="secondary">
            <TriangleAlert aria-hidden className="size-4" /> Failed documents and deliveries{failed ? ` (${failed})` : ''}
          </ButtonLink>
        }
      />
      <Card>
        {items.length === 0 ? (
          <EmptyState icon={<FileText className="size-5" />} title="No templates yet" description="Open a published or approved plan version and assemble its schedule." />
        ) : (
          <Table caption="Document templates">
            <THead>
              <tr>
                <TH>Plan</TH>
                <TH>Form</TH>
                <TH>Template</TH>
                <TH>Status</TH>
                <TH>Findings holding it</TH>
                <TH>Made by</TH>
                <TH>Made</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((t) => (
                <TR key={t.id}>
                  <TD>
                    <Link href={`/plans/versions/${t.planVersionId}`} className="font-medium text-fg hover:text-primary hover:underline">
                      {t.planCode}
                    </Link>
                    <span className="block text-xs text-muted">version {t.planVersion}</span>
                  </TD>
                  <TD>
                    {sentenceCase(t.kind)}
                    <span className="block text-xs text-muted">
                      {t.form.formNumber} ed. {t.form.edition}
                    </span>
                  </TD>
                  <TD>
                    <Link href={`/documents/templates/${t.id}`} className="font-medium text-fg hover:text-primary hover:underline">
                      Version {t.version}
                    </Link>
                  </TD>
                  <TD>
                    <Badge tone={TEMPLATE_TONES[t.status]}>{sentenceCase(t.status)}</Badge>
                  </TD>
                  <TD>{t.holds.open + t.holds.accepted ? `${t.holds.open} open, ${t.holds.accepted} accepted` : 'None'}</TD>
                  <TD>{nameOf(names, t.createdBy)}</TD>
                  <TD className="whitespace-nowrap text-muted">
                    <LocalTime iso={t.createdAt} />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
