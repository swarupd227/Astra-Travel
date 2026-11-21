import { ShieldCheck } from 'lucide-react';
import type { Account, MasterPolicy } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { CreateMasterPolicyDialog } from '../card-forms';

export const metadata = { title: 'Master policies' };

export default async function MasterPoliciesPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('card:read')) return <AccessDenied permission="card:read" />;
  const [policies, accounts] = await Promise.all([
    load(() => api<{ items: MasterPolicy[] }>('/v1/master-policies')),
    load(() => api<{ items: Account[] }>('/v1/accounts', { query: { limit: 200 } })),
  ]);
  const accountName = new Map((accounts.data?.items ?? []).map((a) => [a.id, a.name]));
  const holders = (accounts.data?.items ?? [])
    .filter((a) => (a.kind === 'card_issuer' || a.kind === 'bank') && a.status !== 'closed')
    .map((a) => ({ id: a.id, name: a.name }));

  return (
    <>
      <PageHeader
        eyebrow="Card-linked cover"
        title="Master policies"
        description="Group policies issued to card issuers and banks. Each card programme runs under one, within its states and dates."
        actions={
          me.permissions.includes('card:manage') ? (
            <CreateMasterPolicyDialog accounts={holders} />
          ) : null
        }
      />
      {policies.error ? (
        <ErrorPanel error={policies.error} />
      ) : (
        <Card>
          {policies.data.items.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck className="size-5" />}
              title="No master policies yet"
              description="Register the issuer or bank as an account, then register its master policy."
            />
          ) : (
            <Table caption="Master policies">
              <THead>
                <tr>
                  <TH>Policy number</TH>
                  <TH>Policyholder</TH>
                  <TH>Underwriter</TH>
                  <TH>States</TH>
                  <TH>Effective</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <tbody>
                {policies.data.items.map((p) => (
                  <TR key={p.id}>
                    <TD className="font-mono text-xs font-medium">{p.policyNumber}</TD>
                    <TD>
                      {accountName.get(p.accountId) ?? (
                        <span className="text-muted">Unknown account</span>
                      )}
                    </TD>
                    <TD className="text-muted">{p.underwriter}</TD>
                    <TD className="max-w-48 truncate text-muted" title={p.states.join(', ')}>
                      {p.states.join(', ')}
                    </TD>
                    <TD className="whitespace-nowrap text-muted">
                      {p.effectiveFrom} to {p.effectiveTo ?? 'open-ended'}
                    </TD>
                    <TD>
                      <Badge tone={p.status === 'active' ? 'success' : 'neutral'}>
                        {p.status === 'active' ? 'Active' : 'Cancelled'}
                      </Badge>
                    </TD>
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
