import { Check } from 'lucide-react';
import { PERMISSIONS, ROLE_LABELS, type Permission } from '@astra/contracts';
import { getMe } from '@/lib/api';
import { Badge, Card, CardHeader, DescriptionList, PageHeader } from '@/components/ui/primitives';

export const metadata = { title: 'My access' };

/** Permissions by the part of the business they belong to. The last takes anything not listed. */
const AREAS: { title: string; prefixes: string[] }[] = [
  {
    title: 'Quotes and policies',
    prefixes: ['quotes', 'policies', 'servicing', 'documents', 'cover'],
  },
  { title: 'Underwriting', prefixes: ['underwriting', 'referrals'] },
  { title: 'Products and rating', prefixes: ['plans', 'forms', 'rating', 'refdata', 'proposals'] },
  { title: 'Partners and card cover', prefixes: ['accounts', 'onboarding', 'webhooks', 'card'] },
  { title: 'Billing and reports', prefixes: ['billing', 'reports'] },
  { title: 'Compliance', prefixes: ['filings', 'licences', 'launch', 'audit', 'data', 'claims'] },
  { title: 'AI agents', prefixes: ['agents'] },
  { title: 'Operations', prefixes: ['workbench', 'tasks', 'events', 'flags', 'settings'] },
];

export default async function ProfilePage() {
  const me = (await getMe())!;
  const all = Object.keys(PERMISSIONS) as Permission[];
  const unplaced = all.filter((p) => !AREAS.some((a) => a.prefixes.includes(p.split(':')[0]!)));
  AREAS.at(-1)!.prefixes.push(...new Set(unplaced.map((p) => p.split(':')[0]!)));
  return (
    <>
      <PageHeader
        title="My access"
        description="What you can do here. Ask a platform administrator if you need a different role."
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
          <CardHeader title="What you can do" />
          <div className="divide-y divide-border">
            {AREAS.map((area) => {
              const mine = all.filter(
                (p) => area.prefixes.includes(p.split(':')[0]!) && me.permissions.includes(p),
              );
              return (
                <section key={area.title} className="px-5 py-4" aria-label={area.title}>
                  <h3 className="mb-2 text-sm font-semibold text-fg">{area.title}</h3>
                  {mine.length ? (
                    <ul className="space-y-1.5">
                      {mine.map((p) => (
                        <li key={p} className="flex items-start gap-2.5 text-sm text-fg">
                          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                          {PERMISSIONS[p]}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">No access.</p>
                  )}
                </section>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}
