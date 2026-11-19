import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { Account, WebhookSubscription } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import {
  ACCOUNT_KIND_LABELS,
  ACCOUNT_STATUS_TONES,
  sentenceCase,
  WEBHOOK_STATUS_TONES,
} from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import {
  Badge,
  Card,
  CardHeader,
  DescriptionList,
  EmptyState,
  Notice,
  PageHeader,
} from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { ChangeStatusDialog } from '../account-forms';

export const metadata = { title: 'Account' };

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const me = (await getMe())!;
  if (!me.permissions.includes('accounts:read')) return <AccessDenied permission="accounts:read" />;
  const { accountId } = await params;
  const { created } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) notFound();

  const account = await load(() => api<Account>(`/v1/accounts/${accountId}`));
  if (account.error instanceof ApiProblem && account.error.problem.code === 'not_found') notFound();
  if (account.error) return <ErrorPanel error={account.error} />;
  const a = account.data;

  const canWebhooks = me.permissions.includes('webhooks:read');
  const webhooks = canWebhooks
    ? await load(() =>
        api<{ items: WebhookSubscription[] }>('/v1/webhook-subscriptions', {
          query: { accountId, limit: 50 },
        }),
      )
    : null;

  return (
    <>
      <Link
        href="/accounts"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg"
      >
        <ChevronLeft aria-hidden className="size-4" /> Accounts
      </Link>
      <PageHeader
        eyebrow={ACCOUNT_KIND_LABELS[a.kind]}
        title={a.name}
        description={<span className="font-mono">{a.code}</span>}
        actions={
          <>
            <Badge tone={ACCOUNT_STATUS_TONES[a.status]}>{sentenceCase(a.status)}</Badge>
            {me.permissions.includes('accounts:manage') ? (
              <ChangeStatusDialog accountId={a.id} current={a.status} />
            ) : null}
          </>
        }
      />
      {created ? (
        <div className="mb-6">
          <Notice tone="success" title="Account registered">
            The account is in onboarding. It can go live once the onboarding checklist (contract,
            licences, segment, plans and integration testing) is complete.
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Details" />
          <div className="p-5">
            <DescriptionList
              items={[
                { term: 'Account ID', value: <span className="font-mono text-xs">{a.id}</span> },
                { term: 'Type', value: ACCOUNT_KIND_LABELS[a.kind] },
                { term: 'Registered', value: <LocalTime iso={a.createdAt} /> },
                { term: 'Last changed', value: <LocalTime iso={a.updatedAt} /> },
              ]}
            />
          </div>
        </Card>

        {webhooks ? (
          <Card className="lg:col-span-2">
            <CardHeader
              title="Webhook subscriptions"
              description="Endpoints this account receives signed event notifications on."
              actions={
                <Link
                  href={`/integrations/webhooks?accountId=${a.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Manage
                </Link>
              }
            />
            {webhooks.error ? (
              <p className="px-5 py-4 text-sm text-danger">Subscriptions could not be loaded.</p>
            ) : webhooks.data.items.length === 0 ? (
              <EmptyState
                title="No subscriptions"
                description="This account does not receive webhooks yet."
              />
            ) : (
              <Table caption={`Webhook subscriptions for ${a.name}`}>
                <THead>
                  <tr>
                    <TH>Endpoint</TH>
                    <TH>Events</TH>
                    <TH>Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {webhooks.data.items.map((w) => (
                    <TR key={w.id}>
                      <TD className="max-w-xs truncate font-mono text-xs">{w.url}</TD>
                      <TD className="text-muted">{w.eventTypes.length}</TD>
                      <TD>
                        <Badge tone={WEBHOOK_STATUS_TONES[w.status]}>
                          {sentenceCase(w.status)}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
