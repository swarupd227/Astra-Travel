import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { EventEnvelopeSchema, type EventDefinition, type EventEnvelope } from '@astra/contracts';
import type { RequestContext } from './context';
import type { Tx } from './db';

export interface PublishOptions {
  accountId: string | null;
  state?: string | null;
}

/**
 * Writes a business event to the transactional outbox inside the caller's transaction.
 * The event is only visible to the relay if the business change commits, and it is always relayed
 * if the change commits: no business event is lost (E13-F02-S01).
 */
export async function publishEvent<TSchema extends z.ZodType>(
  tx: Tx,
  ctx: RequestContext,
  def: EventDefinition<string, TSchema>,
  data: z.input<TSchema>,
  opts: PublishOptions,
): Promise<EventEnvelope> {
  const parsed = def.schema.parse(data) as Record<string, unknown>;
  const envelope = EventEnvelopeSchema.parse({
    id: randomUUID(),
    type: def.type,
    version: def.version,
    time: new Date().toISOString(),
    source: def.source,
    correlationId: ctx.correlationId,
    accountId: opts.accountId,
    state: opts.state ?? null,
    data: parsed,
  });
  await tx.query(
    `INSERT INTO platform.outbox
       (id, type, version, occurred_at, source, correlation_id, account_id, state, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      envelope.id,
      envelope.type,
      envelope.version,
      envelope.time,
      envelope.source,
      envelope.correlationId,
      envelope.accountId,
      envelope.state,
      JSON.stringify(envelope.data),
    ],
  );
  return envelope;
}

export interface OutboxRow {
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

export function rowToEnvelope(row: OutboxRow): EventEnvelope {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    time: row.occurred_at.toISOString(),
    source: row.source,
    correlationId: row.correlation_id,
    accountId: row.account_id,
    state: row.state?.trim() ?? null,
    data: row.data,
  };
}
