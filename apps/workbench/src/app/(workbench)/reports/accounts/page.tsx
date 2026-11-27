import type { AccountReport, SalesRow } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { PeriodForm, periodFrom } from '@/components/report-period';
import { Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata = { title: 'Account reports' };

const percent = (r: number) => `${(r * 100).toFixed(1)}%`;

function Sales({ title, first, rows }: { title: string; first: string; rows: SalesRow[] }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <p className="p-5 text-sm text-muted">Nothing in this period.</p>
      ) : (
        <Table caption={title}>
          <THead>
            <tr>
              <TH>{first}</TH>
              <TH className="text-right">Policies sold</TH>
              <TH className="text-right">Premium charged</TH>
              <TH className="text-right">Refunded</TH>
              <TH className="text-right">Net premium</TH>
              <TH className="text-right">Cancellations</TH>
              <TH className="text-right">Refunds</TH>
            </tr>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.key}>
                <TD>{r.label}</TD>
                <TD className="text-right tabular-nums">{r.policiesSold}</TD>
                <TD className="text-right tabular-nums">{r.premiumCharged}</TD>
                <TD className="text-right tabular-nums">{r.premiumRefunded}</TD>
                <TD className="text-right font-medium tabular-nums">{r.netPremium}</TD>
                <TD className="text-right tabular-nums">{r.cancellations}</TD>
                <TD className="text-right tabular-nums">{r.refunds}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export default async function AccountReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('reports:read')) return <AccessDenied permission="reports:read" />;
  const p = periodFrom(await searchParams);
  const res = await load(() => api<AccountReport>('/v1/reports/accounts', { query: p }));
  if (res.error) return <ErrorPanel error={res.error} />;
  const r = res.data;
  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title="Account reports"
        description="Sales, premium, take-up, cancellations and refunds, worked out when you open the page from the premium records, quotes and policies. Amounts are in US dollars by the UTC date of each transaction. Sandbox accounts are left out."
      />
      <Card className="mb-6">
        <PeriodForm {...p} csvHref={`/api/reports/accounts?from=${p.from}&to=${p.to}`} />
      </Card>
      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Policies sold', String(r.totals.policiesSold)],
          ['Net premium', r.totals.netPremium],
          ['Cancellations', String(r.totals.cancellations)],
          ['Refunded', r.totals.premiumRefunded],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border bg-surface p-4 shadow-card">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-6">
        <Sales title="By account" first="Account" rows={r.byAccount} />
        <Sales title="By segment" first="Segment" rows={r.bySegment} />
        <Sales title="By state" first="State" rows={r.byState} />
        <Sales title="By benefit" first="Benefit" rows={r.byBenefit} />
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Quotes that became policies"
              description="Of the quotes made in the period."
            />
            {r.conversion.length === 0 ? (
              <p className="p-5 text-sm text-muted">No quotes in this period.</p>
            ) : (
              <Table caption="Quotes that became policies">
                <THead>
                  <tr>
                    <TH>Account</TH>
                    <TH className="text-right">Quotes</TH>
                    <TH className="text-right">Bought</TH>
                    <TH className="text-right">Share</TH>
                  </tr>
                </THead>
                <tbody>
                  {r.conversion.map((c) => (
                    <TR key={c.accountId}>
                      <TD>{c.account}</TD>
                      <TD className="text-right tabular-nums">{c.quotes}</TD>
                      <TD className="text-right tabular-nums">{c.bound}</TD>
                      <TD className="text-right tabular-nums">{percent(c.rate)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader
              title="Benefit take-up"
              description="Of the policies sold in the period, the share carrying each benefit."
            />
            {r.takeUp.length === 0 ? (
              <p className="p-5 text-sm text-muted">No policies sold in this period.</p>
            ) : (
              <Table caption="Benefit take-up">
                <THead>
                  <tr>
                    <TH>Benefit</TH>
                    <TH className="text-right">Policies</TH>
                    <TH className="text-right">Of</TH>
                    <TH className="text-right">Share</TH>
                  </tr>
                </THead>
                <tbody>
                  {r.takeUp.map((x) => (
                    <TR key={x.benefit}>
                      <TD>
                        {x.name} <span className="font-mono text-xs text-muted">{x.benefit}</span>
                      </TD>
                      <TD className="text-right tabular-nums">{x.policies}</TD>
                      <TD className="text-right tabular-nums">{x.of}</TD>
                      <TD className="text-right tabular-nums">{percent(x.rate)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
