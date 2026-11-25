import Link from 'next/link';
import { Bot } from 'lucide-react';
import type { z } from 'zod';
import type { AgentSampleItemSchema } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';

export const metadata = { title: 'Agent changes' };

export default async function AgentSamplePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('servicing:review')) return <AccessDenied permission="servicing:review" />;
  const { days } = await searchParams;
  const window = days && /^\d{1,2}$/.test(days) ? Number(days) : 7;
  const res = await load(() => api<{ total: number; items: z.infer<typeof AgentSampleItemSchema>[] }>(`/v1/servicing/agent-sample?days=${window}&size=10`));
  if (res.error) return <ErrorPanel error={res.error} />;
  const { total, items } = res.data;
  return (
    <>
      <PageHeader
        eyebrow="Policies"
        title="Changes made by the servicing agent"
        description={`A random sample of up to 10 of the ${total} change${total === 1 ? '' : 's'} the Policy Servicing agent made in the last ${window} days. Open each policy, read its history and the notice issued, and check the agent did what the requester confirmed.`}
      />
      <Card>
        {items.length === 0 ? (
          <EmptyState icon={<Bot className="size-5" />} title="Nothing to review" description="The servicing agent has made no changes in this period." />
        ) : (
          <Table caption="Sample of the servicing agent’s changes">
            <THead>
              <tr>
                <TH>Policy</TH>
                <TH>What</TH>
                <TH>Reason given</TH>
                <TH>Money</TH>
                <TH>When</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((i) => (
                <TR key={`${i.policyId}-${i.seq}`}>
                  <TD>
                    <Link href={`/policies/${i.policyId}`} className="font-medium text-fg hover:text-primary hover:underline">
                      {i.policyNumber}
                    </Link>
                  </TD>
                  <TD>
                    {sentenceCase(i.transaction)}
                    {i.summary ? <span className="block max-w-sm text-xs text-muted">{i.summary}</span> : null}
                  </TD>
                  <TD className="max-w-xs text-sm">{i.reason ?? '—'}</TD>
                  <TD>{i.amount ?? '—'}</TD>
                  <TD className="whitespace-nowrap text-muted">
                    <LocalTime iso={i.occurredAt} />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
