import Link from 'next/link';
import type { PremiumRecord } from '@astra/contracts';
import { api } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { load } from '@/components/error-panel';
import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { RECORD_TONES } from './tones';

const money = (v: string) => `${v.startsWith('-') ? '−' : ''}$${Number(v.replace('-', '')).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  const res = await load(() => api<{ items: PremiumRecord[] }>(`/v1/policies/${policyId}/premium-records`));
  if (res.error || res.data.items.length === 0) return null;
  return (
    <Card className="mb-6">
      <CardHeader title="Premium records" description="What was charged and refunded, and where each stands with Assurant’s billing system." />
      <Table caption="Premium records of this policy">
        <THead>
          <tr>
            <TH>Record</TH>
            <TH>Transaction</TH>
            <TH className="text-right">Charged</TH>
            <TH className="text-right">Refunded</TH>
            <TH>With billing</TH>
          </tr>
        </THead>
        <tbody>
          {res.data.items.map((r) => (
            <TR key={r.id}>
              <TD>
                <Link href={`/billing/records/${r.id}`} className="font-mono text-xs font-medium text-fg hover:text-primary hover:underline">
                  {r.number}
                </Link>
              </TD>
              <TD>{sentenceCase(r.type)}</TD>
              <TD className="text-right font-mono text-xs">{money(r.charge)}</TD>
              <TD className="text-right font-mono text-xs">{money(r.refund)}</TD>
              <TD>
                <Badge tone={RECORD_TONES[r.status]}>{MEANING[r.status]}</Badge>
                {r.billingReference ? <span className="block font-mono text-xs text-muted">{r.billingReference}</span> : null}
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
