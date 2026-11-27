import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { Account, ChannelSettings } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import { ChannelsForm } from './channels-form';

export const metadata = { title: 'Sales channels' };

export default async function ChannelsPage({ params }: { params: Promise<{ accountId: string }> }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('accounts:read')) return <AccessDenied permission="accounts:read" />;
  const { accountId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) notFound();
  const [acc, set] = await Promise.all([
    load(() => api<Account>(`/v1/accounts/${accountId}`)),
    load(() => api<ChannelSettings>(`/v1/accounts/${accountId}/channels`)),
  ]);
  if (acc.error instanceof ApiProblem && acc.error.problem.code === 'not_found') notFound();
  if (acc.error) return <ErrorPanel error={acc.error} />;
  if (set.error) return <ErrorPanel error={set.error} />;
  const s = set.data;
  return (
    <>
      <Link
        href={`/accounts/${accountId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> {acc.data.name}
      </Link>
      <PageHeader
        eyebrow="Sales channels"
        title="Widget, hosted journey and files"
        description="Every channel sells through the same quote and bind rules as the API. Branding is checked for accessible contrast when it is saved."
      />
      {s.journey.enabled && s.journey.slug ? (
        <div className="mb-6">
          <Notice tone="primary" title="The hosted journey is on">
            Travellers use it at{' '}
            <Link
              className="font-mono font-medium text-primary hover:underline"
              href={`/j/${s.journey.slug}`}
              target="_blank"
            >
              /j/{s.journey.slug}
            </Link>
            . Online payment is not set up (no provider has been chosen), so only a sandbox
            account’s journey can complete a purchase, with a labelled test payment.
          </Notice>
        </div>
      ) : null}
      <Card className="mb-6">
        <CardHeader title="Settings" />
        <div className="p-5">
          {me.permissions.includes('accounts:manage') ? (
            <ChannelsForm accountId={accountId} settings={s} />
          ) : (
            <p className="text-sm text-muted">
              Changing the channel settings needs the accounts:manage permission.
            </p>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Booking files"
          description="Accounts without an API send bookings in CSV files. The result file lists each booking as accepted or rejected, with the reasons."
        />
        <p className="p-5 text-sm">
          <Link
            className="text-primary hover:underline"
            href={`/channels/booking-files?accountId=${accountId}`}
          >
            Open the account’s booking files
          </Link>
        </p>
      </Card>
    </>
  );
}
