import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { Plan } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { load } from '@/components/error-panel';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { NewQuoteForm } from '../quote-forms';

export const metadata = { title: 'New quote' };

export default async function NewQuotePage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('quotes:create')) return <AccessDenied permission="quotes:create" />;
  const [accounts, states, accountPlans] = await Promise.all([
    load(() => api<{ items: { id: string; code: string; name: string }[] }>('/v1/accounts?limit=100')),
    load(() => api<{ items: Plan[] }>('/v1/plans?kind=state')),
    load(() => api<{ items: Plan[] }>('/v1/plans?kind=account')),
  ]);
  const plans = [...(states.data?.items ?? []), ...(accountPlans.data?.items ?? [])]
    .filter((p) => p.current?.status === 'published')
    .map((p) => ({ code: p.code, label: `${p.code} · ${p.name}`, state: p.state }));
  return (
    <>
      <Link href="/quotes" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg">
        <ChevronLeft aria-hidden className="size-4" /> Quotes
      </Link>
      <PageHeader eyebrow="Policies" title="New quote" description="Prices every benefit for every traveller with the published rate manuals, and decides eligibility with the plan’s rule set. Nothing is bound here: binding needs the payment system’s confirmation, which arrives through the API." />
      {plans.length === 0 ? (
        <div className="mb-6">
          <Notice tone="warning" title="No plan is published">
            A plan needs its forms filed, its rate manuals published and its tests passing before it can be quoted. See Plans.
          </Notice>
        </div>
      ) : null}
      <NewQuoteForm accounts={(accounts.data?.items ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))} plans={plans} today={new Date().toISOString().slice(0, 10)} />
    </>
  );
}
