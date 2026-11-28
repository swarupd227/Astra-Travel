import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CircleDashed } from 'lucide-react';
import type { Account, Onboarding, WebhookSubscription } from '@astra/contracts';
import { api, ApiProblem, getMe } from '@/lib/api';
import { ACCOUNT_KIND_LABELS, sentenceCase, WEBHOOK_STATUS_TONES } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, Notice } from '@/components/ui/primitives';
import { Table, TD, TH, THead, TR } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { ChangeStatusDialog } from '../account-forms';
import { AccountHeader } from './account-header';

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

  const [webhooks, onboarding] = await Promise.all([
    me.permissions.includes('webhooks:read')
      ? load(() =>
          api<{ items: WebhookSubscription[] }>('/v1/webhook-subscriptions', {
            query: { accountId, limit: 50 },
          }),
        )
      : null,
    load(() => api<Onboarding>(`/v1/accounts/${accountId}/onboarding`)),
  ]);
  const steps = onboarding.data && !onboarding.data.sandbox ? onboarding.data.items : null;
  const done = steps?.filter((s) => s.complete).length ?? 0;
  const open = steps?.filter((s) => !s.complete) ?? [];

  return (
    <>
      <AccountHeader
        account={a}
        current="overview"
        title={a.name}
        actions={
          me.permissions.includes('accounts:manage') ? (
            <ChangeStatusDialog accountId={a.id} current={a.status} />
          ) : null
        }
      />
      {created ? (
        <div className="mb-6">
          <Notice tone="success" title="Account registered">
            The account is in onboarding. It can go live once every item on its onboarding checklist
            is complete.
          </Notice>
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {steps && a.status === 'onboarding' ? (
            <Card aria-labelledby="progress">
              <CardHeader
                titleId="progress"
                title="Getting ready to sell"
                description={`${done} of ${steps.length} onboarding items are complete.`}
                actions={
                  <ButtonLink href={`/accounts/${a.id}/setup`} variant="primary" size="sm">
                    {open.length ? 'Continue onboarding' : 'Take the account live'}
                  </ButtonLink>
                }
              />
              <div className="px-5 pt-4">
                <div
                  role="progressbar"
                  aria-label="Onboarding progress"
                  aria-valuemin={0}
                  aria-valuemax={steps.length}
                  aria-valuenow={done}
                  className="h-2 overflow-hidden rounded-full bg-surface-muted"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <ul className="px-5 py-4">
                {open.slice(0, 5).map((s) => (
                  <li key={s.item} className="flex items-start gap-3 py-1.5 text-sm">
                    <CircleDashed aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                    <span className="text-fg">{s.label}</span>
                  </li>
                ))}
                {open.length > 5 ? (
                  <li className="py-1.5 pl-7 text-sm text-muted">and {open.length - 5} more</li>
                ) : null}
              </ul>
            </Card>
          ) : null}

          {webhooks ? (
            <Card aria-labelledby="webhooks">
              <CardHeader
                titleId="webhooks"
                title="Webhook subscriptions"
                description="Where this account receives signed event notifications."
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
                        <TD className="max-w-xs break-all font-mono text-xs">{w.url}</TD>
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

        <Card aria-labelledby="details">
          <CardHeader titleId="details" title="Details" />
          <dl className="space-y-3 px-5 py-4 text-sm">
            {[
              { term: 'Type', value: ACCOUNT_KIND_LABELS[a.kind] },
              { term: 'Code', value: a.code },
              { term: 'Registered', value: <LocalTime iso={a.createdAt} /> },
              { term: 'Last changed', value: <LocalTime iso={a.updatedAt} /> },
            ].map((i) => (
              <div key={i.term} className="flex justify-between gap-4">
                <dt className="text-muted">{i.term}</dt>
                <dd className="min-w-0 break-words text-right text-fg">{i.value}</dd>
              </div>
            ))}
            <div>
              <dt className="text-muted">Account ID, for the API</dt>
              <dd className="mt-1 break-all font-mono text-xs text-fg">{a.id}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
