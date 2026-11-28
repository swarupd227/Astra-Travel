import Link from 'next/link';
import type { PremiumRecord } from '@astra/contracts';
import { api } from '@/lib/api';
import { money, sentenceCase } from '@/lib/format';
import { load } from '@/components/error-panel';
import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { RECORD_TONES } from './tones';

const MEANING: Record<PremiumRecord['status'], string> = {
  held: 'Held: something is missing',
  ready: 'Ready to send',
  batched: 'In a batch',
  sent: 'Sent, waiting for billing',
  confirmed: 'Confirmed by billing',
  rejected: 'Rejected by billing',
};

/** The premium records of a policy, and where each charge and refund stands with billing (E08-F03-S02). */
export async function PolicyPremium({ policyId }: { policyId: string }) {
  const res = await load(() =>
    api<{ items: PremiumRecord[] }>(`/v1/policies/${policyId}/premium-records`),
  );
  if (res.error || res.data.items.length === 0) return null;
  return (
    <Card aria-labelledby="premium-records">
      <CardHeader
        titleId="premium-records"
        title="Premium records"
        description="Each charge and refund, and where it stands with Assurant’s billing system."
      />
      <ul className="divide-y divide-border">
        {res.data.items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
            <span className="min-w-0 flex-1">
              <Link
                href={`/billing/records/${r.id}`}
                className="block text-sm font-medium text-fg hover:text-primary hover:underline"
              >
                {r.number}
              </Link>
              <span className="block text-xs text-muted">
                {sentenceCase(r.type)}
                {r.billingReference ? ` · billing reference ${r.billingReference}` : ''}
              </span>
            </span>
            <span className="text-right text-sm tabular-nums text-fg">
              {Number(r.charge) ? <span className="block">{money(r.charge)} charged</span> : null}
              {Number(r.refund) ? <span className="block">{money(r.refund)} refunded</span> : null}
            </span>
            <Badge tone={RECORD_TONES[r.status]}>{MEANING[r.status]}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
