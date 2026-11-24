import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import type { Plan, RuleSet } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata = { title: 'Rule sets' };
const TONES = { draft: 'primary', approved: 'warning', published: 'success', superseded: 'neutral' } as const;

export default async function RuleSetPlansPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:read')) return <AccessDenied permission="underwriting:read" />;
  const [states, accounts] = await Promise.all([load(() => api<{ items: Plan[] }>('/v1/plans?kind=state')), load(() => api<{ items: Plan[] }>('/v1/plans?kind=account'))]);
  if (states.error) return <ErrorPanel error={states.error} />;
  const plans = [...states.data.items, ...(accounts.data?.items ?? [])];
  const sets = await Promise.all(plans.map((p) => load(() => api<{ items: Omit<RuleSet, 'document' | 'problems'>[] }>(`/v1/plans/${p.id}/rule-sets`))));
  return (
    <>
      <PageHeader
        eyebrow="Underwriting"
        title="Rule sets"
        description="Plan limits, referral rules and eligibility options for each state and account plan. A rule set is approved by a second person and published only when every test case passes."
      />
      <Card>
        {plans.length === 0 ? (
          <EmptyState icon={<ListChecks className="size-5" />} title="No state or account plans yet" description="Rule sets belong to state and account plans. Build one under Plans first." />
        ) : (
          <Table caption="Plans and their rule sets">
            <THead>
              <tr>
                <TH>Plan</TH>
                <TH>State</TH>
                <TH>Rule set</TH>
              </tr>
            </THead>
            <tbody>
              {plans.map((p, i) => {
                const items = sets[i]?.data?.items ?? [];
                const live = items.find((s) => s.status === 'published') ?? items[0];
                return (
                  <TR key={p.id}>
                    <TD>
                      <Link href={`/underwriting/plans/${p.id}`} className="font-medium text-fg hover:text-primary hover:underline">
                        {p.name}
                      </Link>
                      <span className="block font-mono text-xs text-muted">{p.code}</span>
                    </TD>
                    <TD>{p.state}</TD>
                    <TD>
                      {live ? (
                        <span className="flex items-center gap-2">
                          v{live.version}
                          <Badge tone={TONES[live.status]}>{sentenceCase(live.status)}</Badge>
                        </span>
                      ) : (
                        <span className="text-muted">None yet</span>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
