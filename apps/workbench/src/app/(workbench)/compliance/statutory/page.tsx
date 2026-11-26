import type { StatutoryReport } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { PeriodForm, periodFrom } from '@/components/report-period';
import { Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata = { title: 'Statutory data' };

export default async function StatutoryPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('reports:statutory')) return <AccessDenied permission="reports:statutory" />;
  const p = periodFrom(await searchParams);
  const res = await load(() => api<StatutoryReport>('/v1/reports/statutory', { query: p }));
  if (res.error) return <ErrorPanel error={res.error} />;
  const r = res.data;
  const rec = r.reconciliation;
  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        title="Statutory and statistical data"
        description="Premium and policy counts by state, underwriting entity and benefit, built from the premium records and checked against them. Dates are the UTC date of each transaction."
      />
      <Card className="mb-6">
        <PeriodForm {...p} csvHref={`/api/reports/statutory?from=${p.from}&to=${p.to}`} />
      </Card>
      <div className="mb-6">
        <Notice tone={rec.reconciled ? 'success' : 'danger'} title={rec.reconciled ? 'Reconciled to the accounting totals' : 'Not reconciled'}>
          {rec.records} premium records total {rec.recordPremium}; the report totals {rec.reportPremium} (difference {rec.premiumDifference}). Tax on the records is {rec.recordTax}; in the report {rec.reportTax} (difference {rec.taxDifference}).
          {rec.unbalancedRecords.length ? ` Records whose lines do not add up: ${rec.unbalancedRecords.join(', ')}.` : ''}
        </Notice>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader title="By state, entity and benefit" />
          {r.rows.length === 0 ? (
            <p className="p-5 text-sm text-muted">No premium in this period.</p>
          ) : (
            <Table caption="Premium by state, entity and benefit">
              <THead>
                <tr>
                  <TH>State</TH>
                  <TH>Entity</TH>
                  <TH>Benefit</TH>
                  <TH className="text-right">Transactions</TH>
                  <TH className="text-right">Policies</TH>
                  <TH className="text-right">Premium</TH>
                </tr>
              </THead>
              <tbody>
                {r.rows.map((x) => (
                  <TR key={`${x.state}:${x.entity}:${x.benefit}`}>
                    <TD>{x.state}</TD>
                    <TD>{x.entity}</TD>
                    <TD className="font-mono text-xs">{x.benefit}</TD>
                    <TD className="text-right tabular-nums">{x.transactions}</TD>
                    <TD className="text-right tabular-nums">{x.policies}</TD>
                    <TD className="text-right tabular-nums">{x.premium}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Premium and tax by state and entity" description="A record without tax is waiting for a premium tax rate to be loaded." />
            {r.byEntity.length === 0 ? (
              <p className="p-5 text-sm text-muted">No premium in this period.</p>
            ) : (
              <Table caption="Premium and tax by state and entity">
                <THead>
                  <tr>
                    <TH>State</TH>
                    <TH>Entity</TH>
                    <TH className="text-right">Premium</TH>
                    <TH className="text-right">Tax</TH>
                    <TH className="text-right">Without tax</TH>
                  </tr>
                </THead>
                <tbody>
                  {r.byEntity.map((x) => (
                    <TR key={`${x.state}:${x.entity}`}>
                      <TD>{x.state}</TD>
                      <TD>{x.entity}</TD>
                      <TD className="text-right tabular-nums">{x.premium}</TD>
                      <TD className="text-right tabular-nums">{x.tax}</TD>
                      <TD className="text-right tabular-nums">{x.recordsWithoutTax}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Where the records stand" />
            <ul className="divide-y divide-border">
              {rec.byStatus.map((s) => (
                <li key={s.status} className="flex justify-between px-5 py-3 text-sm">
                  <span>
                    {sentenceCase(s.status)} <span className="text-muted">({s.records})</span>
                  </span>
                  <span className="tabular-nums">{s.premium}</span>
                </li>
              ))}
              {rec.byStatus.length === 0 ? <li className="px-5 py-3 text-sm text-muted">No records.</li> : null}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
