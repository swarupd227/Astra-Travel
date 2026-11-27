import Link from 'next/link';
import type { TemplateSummarySchema } from '@astra/contracts';
import type { z } from 'zod';
import { api } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { load } from '@/components/error-panel';
import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { CreateTemplateForm } from './document-forms';
import { TEMPLATE_TONES } from './tones';

/** The documents card of a plan version: its templates and the controls to assemble the schedule and the policy. */
export async function VersionTemplates({
  versionId,
  hasPolicyForm,
  canManage,
  assemblable,
}: {
  versionId: string;
  hasPolicyForm: boolean;
  canManage: boolean;
  assemblable: boolean;
}) {
  const res = await load(() =>
    api<{ items: z.infer<typeof TemplateSummarySchema>[] }>(
      `/v1/document-templates?planVersionId=${versionId}`,
    ),
  );
  const items = res.data?.items ?? [];
  return (
    <Card className="mb-6">
      <CardHeader
        title="Documents"
        description="The schedule and policy issued to travellers are assembled from the filed forms with this version’s values. A second person releases each template."
      />
      <div className="space-y-4 p-5">
        {items.length === 0 ? (
          <p className="text-sm text-muted">No template has been assembled for this version.</p>
        ) : null}
        {items.length ? (
          <ul className="divide-y divide-border">
            {items.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
              >
                <span>
                  <Link
                    href={`/documents/templates/${t.id}`}
                    className="font-medium text-fg hover:text-primary hover:underline"
                  >
                    {sentenceCase(t.kind)} template, version {t.version}
                  </Link>
                  <span className="block text-xs text-muted">
                    <LocalTime iso={t.createdAt} />
                  </span>
                </span>
                <Badge tone={TEMPLATE_TONES[t.status]}>{sentenceCase(t.status)}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {canManage && assemblable ? (
          <div className="flex flex-wrap gap-3">
            <CreateTemplateForm
              planVersionId={versionId}
              kind="schedule"
              label="Assemble the schedule"
            />
            {hasPolicyForm ? (
              <CreateTemplateForm
                planVersionId={versionId}
                kind="policy"
                label="Assemble the policy"
              />
            ) : null}
          </div>
        ) : null}
        {canManage && !assemblable ? (
          <p className="text-sm text-muted">
            Templates are assembled from approved or published versions.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
