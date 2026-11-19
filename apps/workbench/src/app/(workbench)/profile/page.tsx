import { Check } from 'lucide-react';
import { PERMISSIONS, ROLE_LABELS, type Permission } from '@astra/contracts';
import { getMe } from '@/lib/api';
import { Badge, Card, CardHeader, DescriptionList, PageHeader } from '@/components/ui/primitives';

export const metadata = { title: 'My access' };

export default async function ProfilePage() {
  const me = (await getMe())!;
  const all = Object.keys(PERMISSIONS) as Permission[];
  return (
    <>
      <PageHeader
        title="My access"
        description="Your roles come from your groups in the identity provider. Ask a platform administrator if you need a different role."
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Identity" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'Name', value: me.name ?? '—' },
                { term: 'Email', value: me.email ?? '—' },
                {
                  term: 'Roles',
                  value: (
                    <div className="flex flex-wrap gap-1.5">
                      {me.roles.map((r) => (
                        <Badge key={r} tone="primary">
                          {ROLE_LABELS[r]}
                        </Badge>
                      ))}
                    </div>
                  ),
                },
                {
                  term: 'Account scope',
                  value:
                    me.accountScope.type === 'all'
                      ? 'All accounts'
                      : `${me.accountScope.accountIds.length} account(s)`,
                },
              ]}
            />
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Permissions"
            description="What your roles allow you to do in the platform."
          />
          <ul className="divide-y divide-border">
            {all.map((p) => {
              const has = me.permissions.includes(p);
              return (
                <li key={p} className="flex items-center gap-3 px-5 py-2.5">
                  <span
                    className={`flex size-5 items-center justify-center rounded-full ${has ? 'bg-success-soft text-success' : 'bg-surface-muted text-subtle'}`}
                  >
                    {has ? <Check aria-hidden className="size-3.5" /> : null}
                  </span>
                  <span className={`text-sm ${has ? 'text-fg' : 'text-subtle'}`}>
                    {PERMISSIONS[p]}
                  </span>
                  <span className="sr-only">{has ? 'allowed' : 'not allowed'}</span>
                  <code className="ml-auto font-mono text-[11px] text-subtle">{p}</code>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
