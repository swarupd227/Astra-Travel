import { Webhook } from 'lucide-react';
import { EVENT_TYPES, type Account, type WebhookSubscription } from '@astra/contracts';
import { api, getMe } from '@/lib/api';
import { readParams, sentenceCase, WEBHOOK_STATUS_TONES, type SearchParams } from '@/lib/format';
import { AccessDenied } from '@/components/access-denied';
import { ErrorPanel, load } from '@/components/error-panel';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Pager, Table, TD, TH, THead, TR, withQuery } from '@/components/ui/table';
import { LocalTime } from '@/components/ui/time';
import { CreateWebhookDialog, WebhookStatusButton } from './webhook-forms';

export const metadata = { title: 'Webhooks' };

export default async function WebhooksPage({ searchParams }: { searchParams: SearchParams }) {
  const me = (await getMe())!;
  if (!me.permissions.includes('webhooks:read')) return <AccessDenied permission="webhooks:read" />;
  const params = await readParams(searchParams);
  const canManage = me.permissions.includes('webhooks:manage');

  const [subs, accounts] = await Promise.all([
    load(() =>
      api<{ items: WebhookSubscription[]; nextCursor: string | null }>(
        '/v1/webhook-subscriptions',
        {
          query: {
            accountId: params.accountId,
            status: params.status,
            cursor: params.cursor,
            limit: 25,
          },
        },
      ),
    ),
    load(() => api<{ items: Account[] }>('/v1/accounts', { query: { limit: 200 } })),
  ]);
  const accountNames = new Map((accounts.data?.items ?? []).map((a) => [a.id, a.name]));
  const selectable = (accounts.data?.items ?? []).filter((a) => a.status !== 'closed');

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Where partners are notified of changes. Failed deliveries are retried for about nine hours."
        actions={
          canManage && selectable.length > 0 ? (
            <CreateWebhookDialog
              accounts={selectable}
              eventTypes={EVENT_TYPES}
              defaultAccountId={params.accountId}
            />
          ) : null
        }
      />
      {subs.error ? (
        <ErrorPanel error={subs.error} />
      ) : (
        <Card>
          {subs.data.items.length === 0 ? (
            <EmptyState
              icon={<Webhook className="size-5" />}
              title="No webhook subscriptions"
              description="Partners subscribe their systems to events such as policy bound or cancelled. Subscriptions appear here."
            />
          ) : (
            <>
              <Table caption="Webhook subscriptions">
                <THead>
                  <tr>
                    <TH>Account</TH>
                    <TH>Endpoint</TH>
                    <TH>Events</TH>
                    <TH>Status</TH>
                    <TH>Failures</TH>
                    <TH>Created</TH>
                    {canManage ? <TH className="text-right">Actions</TH> : null}
                  </tr>
                </THead>
                <tbody>
                  {subs.data.items.map((w) => (
                    <TR key={w.id}>
                      <TD className="font-medium">
                        {accountNames.get(w.accountId) ?? w.accountId}
                      </TD>
                      <TD className="max-w-[18rem]">
                        <span className="block truncate font-mono text-xs" title={w.url}>
                          {w.url}
                        </span>
                        {w.description ? (
                          <span className="block text-xs text-muted">{w.description}</span>
                        ) : null}
                      </TD>
                      <TD>
                        <div className="flex max-w-[16rem] flex-wrap gap-1">
                          {w.eventTypes.map((t) => (
                            <span
                              key={t}
                              className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-muted"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </TD>
                      <TD>
                        <Badge tone={WEBHOOK_STATUS_TONES[w.status]}>
                          {sentenceCase(w.status)}
                        </Badge>
                      </TD>
                      <TD
                        className={
                          w.consecutiveFailures > 0 ? 'font-medium text-danger' : 'text-muted'
                        }
                      >
                        {w.consecutiveFailures}
                      </TD>
                      <TD className="text-muted">
                        <LocalTime iso={w.createdAt} />
                      </TD>
                      {canManage ? (
                        <TD className="text-right">
                          {w.status === 'disabled' ? (
                            <span className="text-xs text-subtle">Removed</span>
                          ) : (
                            <div className="flex justify-end gap-2">
                              {w.status === 'active' ? (
                                <WebhookStatusButton
                                  subscriptionId={w.id}
                                  status="paused"
                                  label="Pause"
                                />
                              ) : (
                                <WebhookStatusButton
                                  subscriptionId={w.id}
                                  status="active"
                                  label="Resume"
                                />
                              )}
                              <WebhookStatusButton
                                subscriptionId={w.id}
                                status="disabled"
                                label="Remove"
                                variant="danger"
                              />
                            </div>
                          )}
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </tbody>
              </Table>
              <Pager
                count={subs.data.items.length}
                nextHref={
                  subs.data.nextCursor
                    ? withQuery('/integrations/webhooks', params, { cursor: subs.data.nextCursor })
                    : null
                }
                firstHref={
                  params.cursor
                    ? withQuery('/integrations/webhooks', params, { cursor: null })
                    : null
                }
              />
            </>
          )}
        </Card>
      )}
    </>
  );
}
