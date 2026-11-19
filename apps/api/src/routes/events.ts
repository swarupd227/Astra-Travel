import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  DELIVERY_STATUSES,
  DeliverySchema,
  EventRecordSchema,
  pageOf,
  PageQuerySchema,
  ReplayResultSchema,
  type Delivery,
  type EventRecord,
} from '@astra/contracts';
import {
  decodeCursor,
  encodeCursor,
  notFound,
  replayDeadDeliveries,
  withTx,
  writeAudit,
} from '@astra/platform';
import type { AppDeps } from '../app';
import { commonErrors, iso } from './shared';

interface EventRow {
  seq: string;
  id: string;
  type: string;
  version: number;
  occurred_at: Date;
  source: string;
  correlation_id: string;
  account_id: string | null;
  state: string | null;
  data: Record<string, unknown>;
  published_at: Date | null;
}

interface DeliveryRow {
  event_id: string;
  event_type: string;
  subscriber: string;
  status: Delivery['status'];
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  delivered_at: Date | null;
  updated_at: Date;
  account_id: string | null;
}

const toEvent = (r: EventRow): EventRecord => ({
  id: r.id,
  type: r.type,
  version: r.version,
  time: r.occurred_at.toISOString(),
  source: r.source,
  correlationId: r.correlation_id,
  accountId: r.account_id,
  state: r.state?.trim() ?? null,
  data: r.data,
  publishedAt: iso(r.published_at),
});

const toDelivery = (r: DeliveryRow): Delivery => ({
  eventId: r.event_id,
  eventType: r.event_type,
  subscriber: r.subscriber,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: iso(r.next_attempt_at),
  lastError: r.last_error,
  deliveredAt: iso(r.delivered_at),
  updatedAt: r.updated_at.toISOString(),
  accountId: r.account_id,
});

const DELIVERY_COLUMNS = `event_id, event_type, subscriber, status, attempts, next_attempt_at, last_error,
                          delivered_at, updated_at, account_id`;

export const eventRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/events',
    {
      config: { tenancy: 'platform', permission: 'events:read' },
      schema: {
        tags: ['Events'],
        summary: 'Browse business events, newest first',
        querystring: PageQuerySchema.extend({
          type: z.string().max(64).optional(),
          accountId: z.uuid().optional(),
          correlationId: z.string().max(128).optional(),
        }),
        response: { 200: pageOf(EventRecordSchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, type, accountId, correlationId } = request.query;
      const after = decodeCursor(cursor, 1);
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<EventRow>(
          `SELECT seq, id, type, version, occurred_at, source, correlation_id, account_id, state, data,
                  published_at
             FROM platform.outbox
            WHERE ($1::text IS NULL OR type = $1)
              AND ($2::uuid IS NULL OR account_id = $2)
              AND ($3::text IS NULL OR correlation_id = $3)
              AND ($4::bigint IS NULL OR seq < $4::bigint)
            ORDER BY seq DESC
            LIMIT $5`,
          [type ?? null, accountId ?? null, correlationId ?? null, after?.[0] ?? null, limit + 1],
        ),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toEvent),
        nextCursor: rows.length > limit && last ? encodeCursor([last.seq]) : null,
      };
    },
  );

  app.get(
    '/v1/events/:eventId',
    {
      config: { tenancy: 'platform', permission: 'events:read' },
      schema: {
        tags: ['Events'],
        summary: 'Get an event and the status of each delivery',
        params: z.object({ eventId: z.uuid() }),
        response: {
          200: EventRecordSchema.extend({ deliveries: z.array(DeliverySchema) }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const { eventId } = request.params;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const { rows } = await tx.query<EventRow>(
          `SELECT seq, id, type, version, occurred_at, source, correlation_id, account_id, state, data,
                  published_at
             FROM platform.outbox WHERE id = $1`,
          [eventId],
        );
        if (!rows[0]) throw notFound('Event');
        const deliveries = await tx.query<DeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM platform.event_deliveries WHERE event_id = $1 ORDER BY subscriber`,
          [eventId],
        );
        return { ...toEvent(rows[0]), deliveries: deliveries.rows.map(toDelivery) };
      });
    },
  );

  app.get(
    '/v1/event-deliveries',
    {
      config: { tenancy: 'platform', permission: 'events:read' },
      schema: {
        tags: ['Events'],
        summary: 'List event deliveries, for example the dead-letter queue (status=dead)',
        querystring: PageQuerySchema.extend({
          status: z.enum(DELIVERY_STATUSES).optional(),
          subscriber: z.string().max(200).optional(),
        }),
        response: { 200: pageOf(DeliverySchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, status, subscriber } = request.query;
      const after = decodeCursor(cursor, 3);
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<DeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM platform.event_deliveries
            WHERE ($1::text IS NULL OR status = $1)
              AND ($2::text IS NULL OR subscriber = $2)
              AND ($3::timestamptz IS NULL
                   OR (updated_at, event_id, subscriber) < ($3::timestamptz, $4::uuid, $5::text))
            ORDER BY updated_at DESC, event_id DESC, subscriber DESC
            LIMIT $6`,
          [
            status ?? null,
            subscriber ?? null,
            after?.[0] ?? null,
            after?.[1] ?? null,
            after?.[2] ?? null,
            limit + 1,
          ],
        ),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toDelivery),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor([last.updated_at.toISOString(), last.event_id, last.subscriber])
            : null,
      };
    },
  );

  app.post(
    '/v1/event-deliveries/replay',
    {
      config: { tenancy: 'platform', permission: 'events:replay' },
      schema: {
        tags: ['Events'],
        summary: 'Replay dead-lettered deliveries',
        description: 'Without filters, every dead-lettered delivery is replayed.',
        body: z.object({
          eventId: z.uuid().optional(),
          subscriber: z.string().max(200).optional(),
          reason: z.string().trim().min(3).max(500),
        }),
        response: { 200: ReplayResultSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { eventId, subscriber, reason } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const replayed = await replayDeadDeliveries(tx, { eventId, subscriber });
        await writeAudit(tx, request.ctx, {
          action: 'event_deliveries.replayed',
          resourceType: 'event_delivery',
          resourceId: eventId ?? null,
          reason,
          data: { eventId: eventId ?? null, subscriber: subscriber ?? null, replayed },
        });
        return { replayed };
      });
    },
  );
};
