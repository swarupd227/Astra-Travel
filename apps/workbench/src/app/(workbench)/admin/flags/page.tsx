import type { Account, FeatureFlag } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, PageHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/ui/time';
import { FlagDialog } from './flag-dialog';

export const metadata = { title: 'Feature flags' };

export default async function FlagsPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('flags:read')) return <AccessDenied permission="flags:read" />;
  const canManage = me.permissions.includes('flags:manage');
  const [flags, accounts] = await Promise.all([
    load(() => api<{ items: FeatureFlag[] }>('/v1/feature-flags')),
    load(() => api<{ items: Account[] }>('/v1/accounts', { query: { limit: 200 } })),
  ]);
  if (flags.error) return <ErrorPanel error={flags.error} />;
  const accountList = (accounts.data?.items ?? []).map((a) => ({ id: a.id, name: a.name }));
  const names = new Map(accountList.map((a) => [a.id, a.name]));

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Feature flags"
        description="Release switches. New capabilities ship turned off and are turned on globally or for one account at a time, so a release can be rolled back without a deployment."
      />
      <div className="space-y-4">
        {flags.data.items.map((f) => (
          <Card key={f.key}>
            <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
              <div className="min-w-0 max-w-2xl">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-mono text-sm font-semibold text-fg">{f.key}</h2>
                  <Badge tone={f.enabled ? 'success' : 'neutral'}>{f.enabled ? 'On' : 'Off'}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">{f.description}</p>
                <p className="mt-2 text-xs text-subtle">
                  Last changed <LocalTime iso={f.updatedAt} /> by {f.updatedBy ?? 'system'}
                </p>
              </div>
              {canManage ? (
                <FlagDialog flagKey={f.key} enabled={f.enabled} accounts={accountList} />
              ) : null}
            </div>
            {f.overrides.length > 0 ? (
              <div className="border-t border-border px-5 py-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
                  Account overrides
                </p>
                <ul className="flex flex-wrap gap-2">
                  {f.overrides.map((o) => (
                    <li key={o.accountId}>
                      <Badge tone={o.enabled ? 'success' : 'warning'}>
                        {names.get(o.accountId) ?? o.accountId.slice(0, 8)}:{' '}
                        {o.enabled ? 'on' : 'off'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}
