import Link from 'next/link';
import { Inbox } from 'lucide-react';
import type { Referral } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { sentenceCase } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';

export const metadata = { title: 'Referrals' };

const TONES = { open: 'warning', approved: 'success', declined: 'neutral' } as const;

export default async function ReferralsPage() {
  const me = (await getMe())!;
  if (!me.permissions.includes('underwriting:read'))
    return <AccessDenied permission="underwriting:read" />;
  const res = await load(() => api<{ items: Omit<Referral, 'evaluation'>[] }>('/v1/referrals'));
  if (res.error) return <ErrorPanel error={res.error} />;
  const items = res.data.items;
  return (
    <>
      <PageHeader
        eyebrow="Underwriting"
        title="Referrals"
        description="Cases that met a referral rule, and travellers held for a possible sanctions match. An underwriter decides each one; a decline is always a person's decision."
      />
      <Card>
        {items.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-5" />}
            title="No referrals"
            description="Cases appear here when a rule set refers them or screening holds them."
          />
        ) : (
          <Table caption="Referrals">
            <THead>
              <tr>
                <TH>Case</TH>
                <TH>Kind</TH>
                <TH>Stage</TH>
                <TH>Recommendation</TH>
                <TH>Status</TH>
                <TH>Raised</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link
                      href={`/underwriting/referrals/${r.id}`}
                      className="font-mono text-xs font-medium text-fg hover:text-primary hover:underline"
                    >
                      {r.caseRef}
                    </Link>
                  </TD>
                  <TD>{r.kind === 'sanctions' ? 'Sanctions hold' : 'Underwriting'}</TD>
                  <TD>{sentenceCase(r.stage)}</TD>
                  <TD>
                    {r.recommendation === 'recommend_decline' ? 'Recommends decline' : 'Refer'}
                  </TD>
                  <TD>
                    <Badge tone={TONES[r.status]}>{sentenceCase(r.status)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted">
                    <LocalTime iso={r.createdAt} />
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
