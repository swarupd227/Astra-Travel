import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  ChangeWebhookStatusRequestSchema,
  CreatedWebhookSubscriptionSchema,
  CreateWebhookSubscriptionRequestSchema,
  EVENT_TYPES,
  pageOf,
  PageQuerySchema,
  WEBHOOK_STATUSES,
  WebhookSubscriptionCreated,
  WebhookSubscriptionSchema,
  WebhookSubscriptionStatusChanged,
  type WebhookSubscription,
} from '@astra/contracts';
import {
  AppError,
  canSeeAccount,
  checkTargetResolves,
  decodeCursor,
  encodeCursor,
  generateSigningSecret,
  notFound,
  publishEvent,
  UnsafeTargetError,
  withIdempotency,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import type { AppDeps } from '../app';
import { findAccount } from './accounts';
import { commonErrors, idempotencyHeaders, idempotencyKey } from './shared';

const MAX_ACTIVE_PER_ACCOUNT = 10;

interface SubscriptionRow {
  id: string;
  account_id: string;
  url: string;
  event_types: string[];
  description: string | null;
  status: WebhookSubscription['status'];
  consecutive_failures: number;
  created_at: Date;
  created_by: string;
  secret_ciphertext: string;
  secret_key_id: string;
}

const COLUMNS = `id, account_id, url, event_types, description, status, consecutive_failures,
                 created_at, created_by, secret_ciphertext, secret_key_id`;

function toSubscription(r: SubscriptionRow): WebhookSubscription {
  return {
    id: r.id,
    accountId: r.account_id,
    url: r.url,
    eventTypes: r.event_types,
    description: r.description,
    status: r.status,
    consecutiveFailures: r.consecutive_failures,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
  };
}

async function findSubscription(tx: Tx, id: string, lock = false): Promise<SubscriptionRow | null> {
  const { rows } = await tx.query<SubscriptionRow>(
    `SELECT ${COLUMNS} FROM integration.webhook_subscriptions WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

export const webhookRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  const targetPolicy = { allowPrivate: deps.config.ALLOW_PRIVATE_WEBHOOK_TARGETS };

  app.get(
    '/v1/webhook-subscriptions',
    {
      config: { tenancy: 'account', permission: 'webhooks:read' },
      schema: {
        tags: ['Webhooks'],
        summary: 'List webhook subscriptions',
        querystring: PageQuerySchema.extend({
          accountId: z.uuid().optional(),
          status: z.enum(WEBHOOK_STATUSES).optional(),
        }),
        response: { 200: pageOf(WebhookSubscriptionSchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, accountId, status } = request.query;
      const after = decodeCursor(cursor, 2);
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<SubscriptionRow>(
          `SELECT ${COLUMNS} FROM integration.webhook_subscriptions
            WHERE ($1::uuid IS NULL OR account_id = $1)
              AND ($2::text IS NULL OR status = $2)
              AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $5`,
          [accountId ?? null, status ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
        ),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toSubscription),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor([last.created_at.toISOString(), last.id])
            : null,
      };
    },
  );

  app.post(
    '/v1/webhook-subscriptions',
    {
      config: { tenancy: 'account', permission: 'webhooks:manage' },
      schema: {
        tags: ['Webhooks'],
        summary: 'Subscribe an HTTPS endpoint to platform events',
        description:
          'Deliveries are signed with the returned `signingSecret` (header `Astra-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`). ' +
          'The secret is shown only in this response. Failed deliveries are retried with exponential back-off.',
        headers: idempotencyHeaders,
        body: CreateWebhookSubscriptionRequestSchema,
        response: { 201: CreatedWebhookSubscriptionSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const principal = request.ctx.principal;

      let accountId: string;
      if (principal.accountScope.type === 'accounts') {
        const own = principal.accountScope.accountIds[0]!;
        if (body.accountId && body.accountId !== own) {
          throw new AppError(
            'forbidden',
            'You can only manage subscriptions for your own account.',
          );
        }
        accountId = own;
      } else {
        if (!body.accountId) {
          throw new AppError('validation_failed', undefined, [
            {
              code: 'required',
              message: 'Choose the account this subscription belongs to.',
              field: 'accountId',
            },
          ]);
        }
        accountId = body.accountId;
      }
      if (!canSeeAccount(principal, accountId)) throw notFound('Account');

      const unknown = body.eventTypes.filter((t) => !(EVENT_TYPES as string[]).includes(t));
      if (unknown.length) {
        throw new AppError('validation_failed', undefined, [
          {
            code: 'unknown_event_type',
            message: `Unknown event types: ${unknown.join(', ')}. Known types: ${EVENT_TYPES.join(', ')}.`,
            field: 'eventTypes',
          },
        ]);
      }
      try {
        await checkTargetResolves(body.url, targetPolicy);
      } catch (err) {
        if (err instanceof UnsafeTargetError) {
          throw new AppError('validation_failed', undefined, [
            { code: 'unsafe_url', message: err.message, field: 'url' },
          ]);
        }
        throw new AppError('validation_failed', undefined, [
          { code: 'unresolvable_url', message: 'The host could not be resolved.', field: 'url' },
        ]);
      }

      const result = await withTx(deps.pool, request.ctx, async (tx) => {
        const response = await withIdempotency(
          tx,
          request.ctx,
          {
            key: idempotencyKey(request),
            method: 'POST',
            path: '/v1/webhook-subscriptions',
            body: { ...body, accountId },
            accountId,
          },
          async () => {
            // Serialise subscription changes per account so the limit check cannot race. A row lock
            // would need UPDATE rights on the account row, which partners rightly do not have.
            await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
              `webhooks:${accountId}`,
            ]);
            const account = await findAccount(tx, accountId);
            if (!account) throw notFound('Account');
            if (account.status === 'closed') {
              throw new AppError('conflict', 'The account is closed.');
            }
            const active = await tx.query<{ n: string }>(
              `SELECT count(*) AS n FROM integration.webhook_subscriptions
                WHERE account_id = $1 AND status <> 'disabled'`,
              [accountId],
            );
            if (Number(active.rows[0]!.n) >= MAX_ACTIVE_PER_ACCOUNT) {
              throw new AppError(
                'conflict',
                `An account can have at most ${MAX_ACTIVE_PER_ACCOUNT} webhook subscriptions.`,
              );
            }
            const id = randomUUID();
            const sealed = deps.secrets.seal(generateSigningSecret(), id);
            const { rows } = await tx.query<SubscriptionRow>(
              `INSERT INTO integration.webhook_subscriptions
                 (id, account_id, url, event_types, description, secret_ciphertext, secret_key_id, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
              [
                id,
                accountId,
                body.url,
                [...new Set(body.eventTypes)],
                body.description ?? null,
                sealed.ciphertext,
                sealed.keyId,
                principal.subject,
              ],
            );
            const row = rows[0]!;
            await writeAudit(tx, request.ctx, {
              action: 'webhook_subscription.created',
              resourceType: 'webhook_subscription',
              resourceId: id,
              accountId,
              data: { url: row.url, eventTypes: row.event_types },
            });
            await publishEvent(
              tx,
              request.ctx,
              WebhookSubscriptionCreated,
              { subscriptionId: id, url: row.url, eventTypes: row.event_types },
              { accountId },
            );
            // The stored (replayable) response never contains the secret.
            return { status: 201, body: toSubscription(row) };
          },
        );
        // Attach the signing secret from the encrypted record, for both first and replayed responses.
        const stored = await findSubscription(tx, response.body.id);
        if (!stored) throw notFound('Webhook subscription');
        const signingSecret = deps.secrets.open(
          stored.secret_ciphertext,
          stored.secret_key_id,
          stored.id,
        );
        return { ...response, body: { ...response.body, signingSecret } };
      });

      if (result.replayed) reply.header('idempotent-replayed', 'true');
      reply.header('cache-control', 'no-store');
      return reply
        .code(201)
        .header('location', `/v1/webhook-subscriptions/${result.body.id}`)
        .send(result.body);
    },
  );

  app.get(
    '/v1/webhook-subscriptions/:subscriptionId',
    {
      config: { tenancy: 'account', permission: 'webhooks:read' },
      schema: {
        tags: ['Webhooks'],
        summary: 'Get a webhook subscription',
        params: z.object({ subscriptionId: z.uuid() }),
        response: { 200: WebhookSubscriptionSchema, ...commonErrors },
      },
    },
    async (request) => {
      const row = await withTx(deps.pool, request.ctx, (tx) =>
        findSubscription(tx, request.params.subscriptionId),
      );
      if (!row) throw notFound('Webhook subscription');
      return toSubscription(row);
    },
  );

  async function changeStatus(
    request: { ctx: Parameters<typeof withTx>[1] },
    subscriptionId: string,
    to: 'active' | 'paused' | 'disabled',
  ): Promise<WebhookSubscription> {
    return withTx(deps.pool, request.ctx, async (tx) => {
      const current = await findSubscription(tx, subscriptionId, true);
      if (!current) throw notFound('Webhook subscription');
      if (current.status === 'disabled') {
        throw new AppError('conflict', 'This subscription was removed and cannot be changed.');
      }
      if (current.status === to) return toSubscription(current);
      const { rows } = await tx.query<SubscriptionRow>(
        `UPDATE integration.webhook_subscriptions
            SET status = $2, consecutive_failures = CASE WHEN $2 = 'active' THEN 0 ELSE consecutive_failures END,
                updated_at = now()
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [subscriptionId, to],
      );
      await writeAudit(tx, request.ctx, {
        action:
          to === 'disabled'
            ? 'webhook_subscription.removed'
            : 'webhook_subscription.status_changed',
        resourceType: 'webhook_subscription',
        resourceId: subscriptionId,
        accountId: current.account_id,
        data: { from: current.status, to },
      });
      await publishEvent(
        tx,
        request.ctx,
        WebhookSubscriptionStatusChanged,
        { subscriptionId, from: current.status, to },
        { accountId: current.account_id },
      );
      return toSubscription(rows[0]!);
    });
  }

  app.post(
    '/v1/webhook-subscriptions/:subscriptionId/status',
    {
      config: { tenancy: 'account', permission: 'webhooks:manage' },
      schema: {
        tags: ['Webhooks'],
        summary: 'Pause or resume a webhook subscription',
        params: z.object({ subscriptionId: z.uuid() }),
        body: ChangeWebhookStatusRequestSchema,
        response: { 200: WebhookSubscriptionSchema, ...commonErrors },
      },
    },
    async (request) => changeStatus(request, request.params.subscriptionId, request.body.status),
  );

  app.delete(
    '/v1/webhook-subscriptions/:subscriptionId',
    {
      config: { tenancy: 'account', permission: 'webhooks:manage' },
      schema: {
        tags: ['Webhooks'],
        summary: 'Remove a webhook subscription (no further deliveries)',
        params: z.object({ subscriptionId: z.uuid() }),
        response: { 204: z.null(), ...commonErrors },
      },
    },
    async (request, reply) => {
      await changeStatus(request, request.params.subscriptionId, 'disabled');
      return reply.code(204).send(null);
    },
  );
};
