import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { EventEnvelope } from '@astra/contracts';
import { runWithContext, systemContext, type RequestContext } from '../context';
import { withTx, type Pool, type Tx } from '../db';
import { platformMetrics } from '../metrics';
import { rowToEnvelope, type OutboxRow } from '../outbox';
import type { Logger } from '../logger';

/**
 * Reliable event delivery (E13-F02-S01).
 *
 * 1. Relay: moves committed outbox events into one delivery row per interested subscriber.
 * 2. Dispatch: claims due deliveries (SKIP LOCKED, so many workers can run), calls the handler,
 *    and records success, a retry with exponential back-off, or dead-lettering after the
 *    subscriber's maximum attempts. Dead deliveries raise an alert metric and can be replayed.
 *
 * Delivery is at least once. Handlers must be idempotent (the event ID is the idempotency key).
 */

export type DeliveryResult = void | { defer: { delayMs: number; reason: string } };

export interface SubscriberHandler {
  maxAttempts: number;
  handle(
    event: EventEnvelope,
    info: { subscriber: string; attempt: number },
  ): Promise<DeliveryResult>;
}

export interface SubscriberRegistry {
  /** Names of every subscriber that should receive this event. */
  subscribersFor(tx: Tx, event: EventEnvelope): Promise<string[]>;
  /** Handler for a subscriber name, or undefined if it no longer exists. */
  handlerFor(subscriber: string): SubscriberHandler | undefined;
}

export interface StaticSubscriber extends SubscriberHandler {
  name: string;
  eventTypes: readonly string[] | '*';
}

export interface DynamicSubscriberSource {
  prefix: string;
  subscribersFor(tx: Tx, event: EventEnvelope): Promise<string[]>;
  handler: SubscriberHandler;
}

export class CompositeRegistry implements SubscriberRegistry {
  constructor(
    private readonly statics: StaticSubscriber[] = [],
    private readonly dynamics: DynamicSubscriberSource[] = [],
  ) {}

  async subscribersFor(tx: Tx, event: EventEnvelope): Promise<string[]> {
    const names = this.statics
      .filter((s) => s.eventTypes === '*' || s.eventTypes.includes(event.type))
      .map((s) => s.name);
    for (const d of this.dynamics) names.push(...(await d.subscribersFor(tx, event)));
    return names;
  }

  handlerFor(subscriber: string): SubscriberHandler | undefined {
    const s = this.statics.find((x) => x.name === subscriber);
    if (s) return s;
    return this.dynamics.find((d) => subscriber.startsWith(d.prefix))?.handler;
  }
}

/** Retry schedule for persisted deliveries: 10 s doubling to a 1 hour cap, with jitter. */
export function deliveryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(3_600_000, 10_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

export async function relayOutbox(
  pool: Pool,
  registry: SubscriberRegistry,
  batchSize = 200,
): Promise<number> {
  return withTx(pool, systemContext('event-relay'), async (tx) => {
    const { rows } = await tx.query<OutboxRow>(
      `SELECT seq, id, type, version, occurred_at, source, correlation_id, account_id, state, data,
              published_at
         FROM platform.outbox
        WHERE published_at IS NULL
        ORDER BY seq
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const row of rows) {
      const event = rowToEnvelope(row);
      const subscribers = await registry.subscribersFor(tx, event);
      if (subscribers.length > 0) {
        await tx.query(
          `INSERT INTO platform.event_deliveries (event_id, subscriber, event_type, account_id)
           SELECT $1, s, $2, $3 FROM unnest($4::text[]) AS s
           ON CONFLICT DO NOTHING`,
          [event.id, event.type, event.accountId, subscribers],
        );
      }
      await tx.query('UPDATE platform.outbox SET published_at = now() WHERE id = $1', [event.id]);
    }
    if (rows.length) platformMetrics().eventsRelayed.add(rows.length);
    return rows.length;
  });
}

interface ClaimedDelivery {
  event_id: string;
  subscriber: string;
  attempts: number;
}

export interface DispatchOptions {
  batchSize?: number;
  lockMs?: number;
  concurrency?: number;
  logger?: Logger;
}

export async function dispatchDue(
  pool: Pool,
  registry: SubscriberRegistry,
  opts: DispatchOptions = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 50;
  const lockMs = opts.lockMs ?? 60_000;
  const concurrency = opts.concurrency ?? 8;
  const ctx = systemContext('event-dispatcher');

  const claimed = await withTx(pool, ctx, async (tx) => {
    const claim = await tx.query<ClaimedDelivery>(
      `UPDATE platform.event_deliveries d
          SET locked_until = now() + make_interval(secs => $2::double precision / 1000),
              attempts = d.attempts + 1,
              updated_at = now()
         FROM (SELECT event_id, subscriber FROM platform.event_deliveries
                WHERE status = 'pending' AND next_attempt_at <= now()
                  AND (locked_until IS NULL OR locked_until < now())
                ORDER BY next_attempt_at
                LIMIT $1
                FOR UPDATE SKIP LOCKED) c
        WHERE d.event_id = c.event_id AND d.subscriber = c.subscriber
        RETURNING d.event_id, d.subscriber, d.attempts`,
      [batchSize, lockMs],
    );
    if (claim.rows.length === 0) return [];
    const events = await tx.query<OutboxRow>(
      `SELECT seq, id, type, version, occurred_at, source, correlation_id, account_id, state, data,
              published_at
         FROM platform.outbox WHERE id = ANY($1::uuid[])`,
      [[...new Set(claim.rows.map((r) => r.event_id))]],
    );
    const byId = new Map(events.rows.map((r) => [r.id, rowToEnvelope(r)]));
    return claim.rows.map((r) => ({ ...r, event: byId.get(r.event_id)! }));
  });

  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, claimed.length) }, async () => {
    while (index < claimed.length) {
      const item = claimed[index++]!;
      await deliverOne(pool, registry, item, item.event, opts.logger);
    }
  });
  await Promise.all(workers);
  return claimed.length;
}

const tracer = trace.getTracer('astra.events');

async function deliverOne(
  pool: Pool,
  registry: SubscriberRegistry,
  d: ClaimedDelivery,
  event: EventEnvelope,
  logger?: Logger,
): Promise<void> {
  const m = platformMetrics();
  const attrs = { subscriber: d.subscriber.split(':')[0] ?? d.subscriber, event_type: event.type };
  const ctx: RequestContext = systemContext('event-dispatcher', event.correlationId);
  const handler = registry.handlerFor(d.subscriber);

  await runWithContext(ctx, () =>
    tracer.startActiveSpan(`deliver ${event.type}`, async (span) => {
      span.setAttributes({
        'astra.event.id': event.id,
        'astra.event.type': event.type,
        'astra.subscriber': d.subscriber,
        'astra.attempt': d.attempts,
        'astra.correlation_id': event.correlationId,
      });
      const started = performance.now();
      try {
        if (!handler) throw new Error(`No handler is registered for subscriber ${d.subscriber}`);
        const result = await handler.handle(event, {
          subscriber: d.subscriber,
          attempt: d.attempts,
        });
        if (result && 'defer' in result) {
          await withTx(pool, ctx, (tx) =>
            tx.query(
              `UPDATE platform.event_deliveries
                  SET attempts = attempts - 1, locked_until = NULL, last_error = $3,
                      next_attempt_at = now() + make_interval(secs => $4::double precision / 1000),
                      updated_at = now()
                WHERE event_id = $1 AND subscriber = $2`,
              [d.event_id, d.subscriber, `deferred: ${result.defer.reason}`, result.defer.delayMs],
            ),
          );
          span.setAttribute('astra.delivery.outcome', 'deferred');
          return;
        }
        await withTx(pool, ctx, (tx) =>
          tx.query(
            `UPDATE platform.event_deliveries
                SET status = 'delivered', delivered_at = now(), locked_until = NULL,
                    next_attempt_at = NULL, last_error = NULL, updated_at = now()
              WHERE event_id = $1 AND subscriber = $2`,
            [d.event_id, d.subscriber],
          ),
        );
        m.deliveriesSucceeded.add(1, attrs);
        span.setAttribute('astra.delivery.outcome', 'delivered');
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
        const maxAttempts = handler?.maxAttempts ?? 1;
        const dead = d.attempts >= maxAttempts;
        await withTx(pool, ctx, (tx) =>
          tx.query(
            `UPDATE platform.event_deliveries
                SET status = CASE WHEN $3 THEN 'dead' ELSE 'pending' END,
                    next_attempt_at = CASE WHEN $3 THEN NULL
                                      ELSE now() + make_interval(secs => $4::double precision / 1000) END,
                    locked_until = NULL, last_error = $5, updated_at = now()
              WHERE event_id = $1 AND subscriber = $2`,
            [d.event_id, d.subscriber, dead, deliveryBackoffMs(d.attempts), message],
          ),
        );
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        if (dead) {
          m.deliveriesDeadLettered.add(1, attrs);
          span.setAttribute('astra.delivery.outcome', 'dead_lettered');
          logger?.error(
            {
              eventId: event.id,
              eventType: event.type,
              subscriber: d.subscriber,
              attempts: d.attempts,
              err: message,
              alert: 'event_dead_lettered',
            },
            'Event delivery dead-lettered after maximum attempts',
          );
        } else {
          m.deliveriesFailed.add(1, attrs);
          span.setAttribute('astra.delivery.outcome', 'retry');
          logger?.warn(
            {
              eventId: event.id,
              eventType: event.type,
              subscriber: d.subscriber,
              attempts: d.attempts,
              err: message,
            },
            'Event delivery failed; will retry',
          );
        }
      } finally {
        m.deliveryDuration.record(performance.now() - started, attrs);
        span.end();
      }
    }),
  );
}

export interface ReplayFilter {
  eventId?: string;
  subscriber?: string;
}

/** Puts dead-lettered deliveries back in the queue. Returns how many were replayed. */
export async function replayDeadDeliveries(tx: Tx, filter: ReplayFilter = {}): Promise<number> {
  const res = await tx.query(
    `UPDATE platform.event_deliveries
        SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL,
            updated_at = now()
      WHERE status = 'dead'
        AND ($1::uuid IS NULL OR event_id = $1::uuid)
        AND ($2::text IS NULL OR subscriber = $2::text)`,
    [filter.eventId ?? null, filter.subscriber ?? null],
  );
  return res.rowCount ?? 0;
}
