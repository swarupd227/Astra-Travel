import type { Plan } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { PageHeader } from '@/components/ui/primitives';
import { CheckForm } from '../uw-forms';

export const metadata = { title: 'Eligibility check' };

export default async function CheckPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:evaluate')) return <AccessDenied permission="underwriting:evaluate" />;
  const [states, accounts] = await Promise.all([load(() => api<{ items: Plan[] }>('/v1/plans?kind=state')), load(() => api<{ items: Plan[] }>('/v1/plans?kind=account'))]);
  if (states.error) return <ErrorPanel error={states.error} />;
  const versions = [...states.data.items, ...(accounts.data?.items ?? [])]
    .filter((p) => p.current)
    .map((p) => ({ id: p.current!.id, label: `${p.code} · ${p.state} · version ${p.current!.version} (${p.current!.status})` }));
  return (
    <>
      <PageHeader
        eyebrow="Underwriting"
        title="Eligibility check"
        description="Run a case through the rules a quote or bind would use: plan limits, prohibited destinations, sanctions screening, duplicate cover, referral rules, the pre-existing waiver and CFAR. Nothing is saved."
      />
      <CheckForm planVersions={versions} today={new Date().toISOString().slice(0, 10)} />
    </>
  );
}
