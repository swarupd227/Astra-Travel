import Link from 'next/link';
import type { RefdataDatasetSummary } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { integer } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata = { title: 'Reference data' };

export default async function ReferenceDataPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('refdata:read')) return <AccessDenied permission="refdata:read" />;
  const result = await load(() => api<{ items: RefdataDatasetSummary[] }>('/v1/reference-data'));

  return (
    <>
      <PageHeader
        title="Reference data"
        description="The lists that rules, rates and documents rely on. A second person approves each change."
      />
      {result.error ? (
        <ErrorPanel error={result.error} />
      ) : (
        <Card>
          <Table caption="Reference datasets">
            <THead>
              <tr>
                <TH>Dataset</TH>
                <TH>In force today</TH>
                <TH className="text-right">Entries</TH>
                <TH>Waiting for approval</TH>
              </tr>
            </THead>
            <tbody>
              {result.data.items.map((d) => (
                <TR key={d.code}>
                  <TD>
                    <Link
                      href={`/reference-data/${d.code}`}
                      className="font-medium text-fg hover:text-primary hover:underline"
                    >
                      {d.name}
                    </Link>
                    <div className="max-w-xl text-xs text-muted">{d.description}</div>
                  </TD>
                  <TD>
                    {d.inForce ? (
                      <span>
                        Version {d.inForce.version}{' '}
                        <span className="text-muted">since {d.inForce.effectiveFrom}</span>
                      </span>
                    ) : (
                      <Badge tone="warning">Awaiting source</Badge>
                    )}
                    {!d.inForce ? (
                      <div className="mt-1 text-xs text-muted">Expected: {d.expectedSource}</div>
                    ) : null}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {d.inForce ? integer(d.inForce.entryCount) : '—'}
                  </TD>
                  <TD>
                    {d.pending ? (
                      <Badge tone="primary">
                        {d.pending} draft{d.pending > 1 ? 's' : ''}
                      </Badge>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
