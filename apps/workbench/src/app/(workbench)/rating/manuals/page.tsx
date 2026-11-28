import Link from 'next/link';
import { Table2 } from 'lucide-react';
import type { RateManual } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadManualDialog } from '../rating-forms';

export const metadata = { title: 'Rate manuals' };

const TONES = {
  draft: 'primary',
  approved: 'warning',
  published: 'success',
  withdrawn: 'neutral',
} as const;

export default async function ManualsPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('rating:read')) return <AccessDenied permission="rating:read" />;
  const result = await load(() =>
    api<{ items: (Omit<RateManual, 'document'> & { tables: number })[] }>('/v1/rate-manuals'),
  );
  return (
    <>
      <PageHeader
        title="Rate manuals"
        description="Filed rates by state and benefit. A manual prices quotes only after approval and testing."
        actions={
          me.permissions.includes('rating:manage') ? (
            <LoadManualDialog
              allowIllustrative={process.env.ALLOW_ILLUSTRATIVE_RATING === 'true'}
            />
          ) : null
        }
      />
      {result.error ? (
        <ErrorPanel error={result.error} />
      ) : (
        <Card>
          {result.data.items.length === 0 ? (
            <EmptyState
              icon={<Table2 className="size-5" />}
              title="No rate manuals loaded"
              description="The Delaware Trip Cancellation manual (RETR-SP-VU-DE-0426) and the other launch-state manuals have not been provided yet."
            />
          ) : (
            <Table caption="Rate manuals">
              <THead>
                <tr>
                  <TH>Manual</TH>
                  <TH>State · benefit</TH>
                  <TH>Status</TH>
                  <TH>Effective</TH>
                  <TH className="text-right">Tables</TH>
                </tr>
              </THead>
              <tbody>
                {result.data.items.map((m) => (
                  <TR key={m.id}>
                    <TD>
                      <Link
                        href={`/rating/manuals/${m.id}`}
                        className="font-mono text-xs font-medium text-fg hover:text-primary hover:underline"
                      >
                        {m.code} v{m.version}
                      </Link>
                      {m.illustrative ? (
                        <span className="ml-2">
                          <Badge tone="danger">Illustrative</Badge>
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      {m.state} · {m.benefit}
                    </TD>
                    <TD>
                      <Badge tone={TONES[m.status]}>{sentenceCase(m.status)}</Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-muted">
                      {m.effectiveFrom}
                      {m.effectiveTo ? ` to ${m.effectiveTo}` : ''}
                    </TD>
                    <TD className="text-right tabular-nums">{m.tables}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
