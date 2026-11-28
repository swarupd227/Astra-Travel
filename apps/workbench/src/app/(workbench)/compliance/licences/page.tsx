import Link from 'next/link';
import { Stamp } from 'lucide-react';
import { LICENCE_KIND_LABELS, type Licence } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, Notice, PageHeader } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata = { title: 'Licences and registrations' };

export default async function LicencesPage({
  searchParams,
}: {
  searchParams: Promise<{ within?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('accounts:read')) return <AccessDenied permission="accounts:read" />;
  const { within } = await searchParams;
  const days = within && /^\d{1,4}$/.test(within) ? Number(within) : 90;
  const res = await load(() =>
    api<{ items: Licence[] }>(`/v1/licences?expiringWithinDays=${days}`),
  );
  if (res.error) return <ErrorPanel error={res.error} />;
  const items = res.data.items;
  return (
    <>
      <PageHeader
        title="Licences and registrations"
        description={`Active licences and registrations that expire within ${days} days, soonest first. An alert goes out 60 and 30 days before expiry; an account that has gone live cannot sell in a state once its licence there has expired.`}
      />
      <nav aria-label="Window" className="mb-4 flex flex-wrap gap-2">
        {[30, 60, 90, 180].map((d) => (
          <Link
            key={d}
            href={`/compliance/licences?within=${d}`}
            aria-current={days === d ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${days === d ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-fg'}`}
          >
            {d} days
          </Link>
        ))}
      </nav>
      {items.some((l) => !l.inForce) ? (
        <div className="mb-6">
          <Notice tone="danger" title="Some have already expired">
            Accounts that have gone live cannot sell in those states until a new licence is
            recorded.
          </Notice>
        </div>
      ) : null}
      <Card>
        {items.length === 0 ? (
          <EmptyState
            icon={<Stamp className="size-5" />}
            title="Nothing expires soon"
            description={`No active licence or registration expires within ${days} days.`}
          />
        ) : (
          <Table caption="Licences expiring soon">
            <THead>
              <tr>
                <TH>Account</TH>
                <TH>State</TH>
                <TH>Kind</TH>
                <TH>Number</TH>
                <TH>Expires</TH>
                <TH>Alerts sent</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((l) => (
                <TR key={l.id}>
                  <TD>
                    <Link
                      href={`/accounts/${l.accountId}/setup`}
                      className="font-medium text-fg hover:text-primary hover:underline"
                    >
                      {l.accountName ?? l.accountId.slice(0, 8)}
                    </Link>
                  </TD>
                  <TD>{l.state}</TD>
                  <TD>{LICENCE_KIND_LABELS[l.kind]}</TD>
                  <TD className="font-mono text-xs">{l.number}</TD>
                  <TD>
                    {l.expiresOn}
                    <Badge
                      tone={l.daysLeft < 0 ? 'danger' : l.daysLeft <= 30 ? 'warning' : 'neutral'}
                    >
                      {l.daysLeft < 0 ? 'Expired' : `${l.daysLeft} days`}
                    </Badge>
                  </TD>
                  <TD>
                    {l.alertsSent.length
                      ? l.alertsSent.map((d) => `${d}-day`).join(', ')
                      : 'None yet'}
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
