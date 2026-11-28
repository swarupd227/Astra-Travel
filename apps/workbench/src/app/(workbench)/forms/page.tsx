import Link from 'next/link';
import { FileText } from 'lucide-react';
import type { FormEdition } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { filingInForce, sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadEditionDialog } from './form-forms';

export const metadata = { title: 'Forms & schedules' };

export default async function FormsPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('forms:read')) return <AccessDenied permission="forms:read" />;
  const result = await load(() => api<{ items: FormEdition[] }>('/v1/form-editions'));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title="Forms & schedules"
        description="Filed forms and schedules, where each is approved, and what a plan may set in them."
        actions={me.permissions.includes('forms:manage') ? <LoadEditionDialog /> : null}
      />
      {result.error ? (
        <ErrorPanel error={result.error} />
      ) : (
        <Card>
          {result.data.items.length === 0 ? (
            <EmptyState
              icon={<FileText className="size-5" />}
              title="No forms loaded yet"
              description="Load each filed form and schedule edition as approved (PDF with a text layer, or a text export)."
            />
          ) : (
            <Table caption="Form and schedule editions">
              <THead>
                <tr>
                  <TH>Form</TH>
                  <TH>Edition</TH>
                  <TH>Kind</TH>
                  <TH>Approved in (today)</TH>
                  <TH>Variable map</TH>
                </tr>
              </THead>
              <tbody>
                {result.data.items.map((e) => {
                  const inForce = e.filings
                    .filter((f) => filingInForce(f, today))
                    .map((f) => f.state);
                  return (
                    <TR key={e.id}>
                      <TD>
                        <Link
                          href={`/forms/${e.id}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {e.title}
                        </Link>
                        <div className="font-mono text-xs text-muted">{e.formNumber}</div>
                      </TD>
                      <TD className="font-mono text-xs">{e.edition}</TD>
                      <TD className="text-muted">
                        {sentenceCase(e.kind)} · {e.insurer}
                      </TD>
                      <TD>
                        {inForce.length ? (
                          inForce.join(', ')
                        ) : (
                          <span className="text-muted">None</span>
                        )}
                      </TD>
                      <TD>
                        {e.currentMap ? (
                          <Badge tone="success">
                            v{e.currentMap.version} · {e.currentMap.variables} variables
                          </Badge>
                        ) : (
                          <span className="text-muted">None</span>
                        )}
                        {e.draftMap ? (
                          <span className="ml-2">
                            <Badge tone="primary">Draft v{e.draftMap.version}</Badge>
                          </span>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
