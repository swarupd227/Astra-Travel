import Link from 'next/link';
import { Layers } from 'lucide-react';
import type { Plan } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { NewPlanDialog } from './plan-forms';
import { VERSION_TONES } from './tones';

export const metadata = { title: 'Plans' };

const KINDS = [
  [
    'base',
    'Base plans',
    'Templates built from an approved benefit catalogue. Approved, never sold.',
  ],
  [
    'state',
    'State plans',
    'A base plan adapted for one state, with its filed forms and rate manuals. These are published.',
  ],
  [
    'account',
    'Account plans',
    'A published state plan adapted for one account, within the base plan’s bounds.',
  ],
] as const;

export default async function PlansPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('plans:read')) return <AccessDenied permission="plans:read" />;
  const canManage = me.permissions.includes('plans:manage');
  const [plans, catalogues, accounts] = await Promise.all([
    load(() => api<{ items: Plan[] }>('/v1/plans')),
    canManage
      ? load(() =>
          api<{
            items: {
              id: string;
              version: number;
              formNumber: string;
              edition: string;
              title: string;
            }[];
          }>('/v1/plan-catalogues'),
        )
      : Promise.resolve({ data: { items: [] }, error: null }),
    canManage && me.permissions.includes('accounts:read')
      ? load(() => api<{ items: { id: string; code: string; name: string }[] }>('/v1/accounts'))
      : Promise.resolve({ data: { items: [] }, error: null }),
  ]);
  if (plans.error) return <ErrorPanel error={plans.error} />;
  const items = plans.data.items;
  const byId = new Map(items.map((p) => [p.id, p]));

  return (
    <>
      <PageHeader
        title="Plans"
        description="What each plan covers. A second person approves every version before it can be sold."
        actions={
          canManage ? (
            <NewPlanDialog
              catalogues={(catalogues.data?.items ?? []).map((c) => ({
                id: c.id,
                label: `${c.formNumber} (${c.edition}) · catalogue v${c.version}`,
              }))}
              basePlans={items
                .filter((p) => p.kind === 'base' && p.current)
                .map((p) => ({ id: p.id, label: `${p.code} · ${p.name}` }))}
              statePlans={items
                .filter((p) => p.kind === 'state' && p.current?.status === 'published')
                .map((p) => ({ id: p.id, label: `${p.code} · ${p.state} · ${p.name}` }))}
              accounts={(accounts.data?.items ?? []).map((a) => ({
                id: a.id,
                label: `${a.code} · ${a.name}`,
              }))}
            />
          ) : null
        }
      />
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers className="size-5" />}
            title="No plans yet"
            description="Start with a base plan built from an approved benefit catalogue."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {KINDS.map(([kind, title, description]) => {
            const rows = items.filter((p) => p.kind === kind);
            if (!rows.length) return null;
            return (
              <Card key={kind}>
                <CardHeader title={title} description={description} />
                <Table caption={title}>
                  <THead>
                    <tr>
                      <TH>Plan</TH>
                      {kind !== 'base' ? <TH>From</TH> : null}
                      <TH>State</TH>
                      <TH>Current version</TH>
                      <TH>Draft</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {rows.map((p) => (
                      <TR key={p.id}>
                        <TD>
                          <Link
                            href={`/plans/${p.id}`}
                            className="font-medium text-fg hover:text-primary hover:underline"
                          >
                            {p.name}
                          </Link>
                          <span className="block font-mono text-xs text-muted">{p.code}</span>
                        </TD>
                        {kind !== 'base' ? (
                          <TD className="font-mono text-xs">
                            {p.parentPlanId ? (byId.get(p.parentPlanId)?.code ?? '—') : '—'}
                          </TD>
                        ) : null}
                        <TD>{p.state ?? 'All'}</TD>
                        <TD>
                          {p.current ? (
                            <span className="flex items-center gap-2">
                              v{p.current.version}
                              <Badge
                                tone={VERSION_TONES[p.current.status as keyof typeof VERSION_TONES]}
                              >
                                {sentenceCase(p.current.status)}
                              </Badge>
                              <span className="text-xs text-muted">
                                from {p.current.effectiveFrom}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted">None yet</span>
                          )}
                        </TD>
                        <TD>
                          {p.draft ? (
                            <Link
                              href={`/plans/versions/${p.draft.id}`}
                              className="text-primary hover:underline"
                            >
                              v{p.draft.version} draft
                            </Link>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
