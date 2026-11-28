import type { Plan } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { load } from '@/components/error-panel';
import { BackLink } from '@/components/ui/back-link';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { NewQuoteForm } from '../quote-forms';

export const metadata = { title: 'New quote' };

export default async function NewQuotePage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('quotes:create')) return <AccessDenied permission="quotes:create" />;
  const [accounts, states, accountPlans] = await Promise.all([
    load(() =>
      api<{ items: { id: string; code: string; name: string }[] }>('/v1/accounts?limit=100'),
    ),
    load(() => api<{ items: Plan[] }>('/v1/plans?kind=state')),
    load(() => api<{ items: Plan[] }>('/v1/plans?kind=account')),
  ]);
  const plans = [...(states.data?.items ?? []), ...(accountPlans.data?.items ?? [])]
    .filter((p) => p.current?.status === 'published')
    .map((p) => ({ code: p.code, label: `${p.name} (${p.code})`, state: p.state }));
  return (
    <>
      <BackLink href="/quotes">Quotes</BackLink>
      <PageHeader
        title="New quote"
        description="Prices each benefit for each traveller with the published rates and checks eligibility."
      />
      {plans.length === 0 ? (
        <div className="mb-6">
          <Notice tone="warning" title="No plan is published">
            A plan needs its forms filed, its rate manuals published and its tests passing before it
            can be quoted. See Plans.
          </Notice>
        </div>
      ) : null}
      <NewQuoteForm
        accounts={(accounts.data?.items ?? []).map((a) => ({
          id: a.id,
          label: `${a.name} (${a.code})`,
        }))}
        plans={plans}
        today={new Date().toISOString().slice(0, 10)}
      />
    </>
  );
}
