import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { CommissionRule, ProgrammeRuleSchema } from '@astra/contracts';
import type { z } from 'zod';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import {
  ApproveRuleForm,
  CommissionRuleForm,
  ProgrammePremiumForm,
  ProgrammeRuleForm,
} from '../billing-forms';

export const metadata = { title: 'Commission and programme rules' };

type Programme = { id: string; name: string; code: string };
type Account = { id: string; name: string };
const describe = (d: CommissionRule['document']) =>
  d.kind === 'none'
    ? 'No commission'
    : d.kind === 'flat'
      ? `Flat ${d.percent}%`
      : d.kind === 'tiered'
        ? d.tiers
            .map(
              (t) =>
                `${t.upTo === null ? 'rest' : `to $${t.upTo.toLocaleString('en-US')}`}: ${t.percent}%`,
            )
            .join('; ')
        : d.bands.map((b) => `from ${b.minPolicies} policies: ${b.percent}%`).join('; ');

export default async function RulesPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('billing:read')) return <AccessDenied permission="billing:read" />;
  const [rules, progRules, accounts, programmes] = await Promise.all([
    load(() => api<{ items: CommissionRule[] }>('/v1/commission-rules')),
    load(() =>
      api<{ items: z.infer<typeof ProgrammeRuleSchema>[] }>('/v1/programme-premium-rules'),
    ),
    load(() => api<{ items: Account[] }>('/v1/accounts?limit=100')),
    load(() => api<{ items: Programme[] }>('/v1/card-programmes?limit=100')),
  ]);
  if (rules.error) return <ErrorPanel error={rules.error} />;
  const canManage = me.permissions.includes('billing:manage');
  const canApprove = me.permissions.includes('billing:approve');
  const accountName = new Map((accounts.data?.items ?? []).map((a) => [a.id, a.name]));
  const programmeName = new Map((programmes.data?.items ?? []).map((p) => [p.id, p.name]));
  return (
    <>
      <Link
        href="/billing"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Premium records
      </Link>
      <PageHeader
        title="Commission and programme rules"
        description="How commission and card premium are calculated. A second person approves each rule."
      />

      <Card className="mb-6">
        <CardHeader
          title="Commission rules"
          description="Flat, tiered or by volume. A refund takes back commission at the rate the original premium earned."
        />
        {rules.data.items.length === 0 ? (
          <EmptyState
            title="No commission rules"
            description="Propose one for each account below."
          />
        ) : (
          <Table caption="Commission rules">
            <THead>
              <tr>
                <TH>Account</TH>
                <TH>Version</TH>
                <TH>From</TH>
                <TH>Rule</TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Approve</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {rules.data.items.map((r) => (
                <TR key={r.id}>
                  <TD>{accountName.get(r.accountId) ?? r.accountId.slice(0, 8)}</TD>
                  <TD>{r.version}</TD>
                  <TD>{r.effectiveFrom}</TD>
                  <TD className="max-w-md text-sm">{describe(r.document)}</TD>
                  <TD>
                    <Badge
                      tone={
                        r.status === 'approved'
                          ? 'success'
                          : r.status === 'draft'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {sentenceCase(r.status)}
                    </Badge>
                  </TD>
                  <TD>
                    {canApprove && r.status === 'draft' ? <ApproveRuleForm ruleId={r.id} /> : null}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
        {canManage ? (
          <div className="border-t border-border p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">Propose a commission rule</h3>
            <CommissionRuleForm
              accounts={(accounts.data?.items ?? []).map((a) => ({ id: a.id, name: a.name }))}
            />
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Card programme premium"
          description="Programme-level premium for card-linked cover: a rate per eligible account per month. Each month’s record counts the accounts eligible on its last day."
        />
        {progRules.data?.items.length ? (
          <Table caption="Programme premium rates">
            <THead>
              <tr>
                <TH>Programme</TH>
                <TH>Version</TH>
                <TH>From</TH>
                <TH className="text-right">Rate per account per month</TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Approve</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {progRules.data.items.map((r) => (
                <TR key={r.id}>
                  <TD>{programmeName.get(r.programmeId) ?? r.programmeId.slice(0, 8)}</TD>
                  <TD>{r.version}</TD>
                  <TD>{r.effectiveFrom}</TD>
                  <TD className="text-right font-mono text-xs">${r.rate}</TD>
                  <TD>
                    <Badge
                      tone={
                        r.status === 'approved'
                          ? 'success'
                          : r.status === 'draft'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {sentenceCase(r.status)}
                    </Badge>
                  </TD>
                  <TD>
                    {canApprove && r.status === 'draft' ? (
                      <ApproveRuleForm ruleId={r.id} programme />
                    ) : null}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-5 text-sm text-muted">No programme rate has been proposed.</p>
        )}
        {canManage && programmes.data?.items.length ? (
          <div className="space-y-6 border-t border-border p-5">
            <div>
              <h3 className="mb-3 text-sm font-semibold text-fg">Propose a programme rate</h3>
              <ProgrammeRuleForm
                programmes={programmes.data.items.map((p) => ({ id: p.id, name: p.name }))}
              />
            </div>
            <div>
              <h3 className="mb-3 text-sm font-semibold text-fg">
                Create a month’s premium record
              </h3>
              <ProgrammePremiumForm
                programmes={programmes.data.items.map((p) => ({ id: p.id, name: p.name }))}
              />
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
