import Link from 'next/link';
import { Calculator } from 'lucide-react';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';

export const metadata = { title: 'Quotes' };

type Item = { id: string; accountId: string; status: string; revision: number; createdAt: string; expiresAt: string; state: string; outcome: string; bindable: boolean; planCode: string; total: string | null };
const OUTCOME = { eligible: 'success', ineligible: 'danger', referred: 'warning', held: 'warning' } as const;

export default async function QuotesPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('quotes:read')) return <AccessDenied permission="quotes:read" />;
  const res = await load(() => api<{ items: Item[] }>('/v1/quotes?limit=50'));
  if (res.error) return <ErrorPanel error={res.error} />;
  const items = res.data.items;
  return (
    <>
      <PageHeader
        eyebrow="Policies"
        title="Quotes"
        description="Priced and decided offers. A quote records the plan, rule set and rate manual versions it was made with; changing the optional benefits re-rates the same quote."
        actions={
          me.permissions.includes('quotes:create') ? (
            <ButtonLink href="/quotes/new">
              <Calculator aria-hidden className="size-4" /> New quote
            </ButtonLink>
          ) : null
        }
      />
      <Card>
        {items.length === 0 ? (
          <EmptyState icon={<Calculator className="size-5" />} title="No quotes yet" description="Quotes made through the API or here appear in this list." />
        ) : (
          <Table caption="Quotes">
            <THead>
              <tr>
                <TH>Quote</TH>
                <TH>Plan</TH>
                <TH>Decision</TH>
                <TH>Status</TH>
                <TH className="text-right">Total</TH>
                <TH>Made</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((q) => (
                <TR key={q.id}>
                  <TD>
                    <Link href={`/quotes/${q.id}`} className="font-mono text-xs font-medium text-fg hover:text-primary hover:underline">
                      {q.id.slice(0, 8)}
                    </Link>
                    {q.revision > 1 ? <span className="ml-2 text-xs text-muted">revision {q.revision}</span> : null}
                  </TD>
                  <TD>
                    {q.planCode} · {q.state}
                  </TD>
                  <TD>
                    <Badge tone={OUTCOME[q.outcome as keyof typeof OUTCOME]}>{sentenceCase(q.outcome)}</Badge>
                  </TD>
                  <TD>{sentenceCase(q.status)}</TD>
                  <TD className="text-right font-mono text-xs">{q.total ?? '—'}</TD>
                  <TD className="whitespace-nowrap text-muted">
                    <LocalTime iso={q.createdAt} />
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
