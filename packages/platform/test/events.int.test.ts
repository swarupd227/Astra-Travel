/** E13-F02-S01: reliable delivery, retries, dead-letter queue and replay against a real database. */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountRegistered, type EventEnvelope } from '@astra/contracts';
import {
  CompositeRegistry,
  createPool,
  dispatchDue,
  publishEvent,
  relayOutbox,
  replayDeadDeliveries,
  systemContext,
  withTx,
  type DeliveryResult,
  type Pool,
} from '../src/index';

const url = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
let pool: Pool;

beforeAll(() => {
  if (!url || !ownerUrl)
    throw new Error('TEST_DATABASE_URL and TEST_DATABASE_OWNER_URL must be set');
  pool = createPool(url, { max: 4 });
});
afterAll(async () => pool.end());
beforeEach(async () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query('TRUNCATE platform.event_deliveries, platform.outbox CASCADE');
  await owner.end();
});

async function emit(): Promise<EventEnvelope> {
  return withTx(pool, systemContext('test', 'corr-events-test'), (tx) =>
    publishEvent(
      tx,
      systemContext('test', 'corr-events-test'),
      AccountRegistered,
      {
        accountId: '7d1f6c2a-3b4e-4f5a-8b6c-9d0e1f2a3b09',
        code: 'EVT',
        name: 'Events',
        kind: 'bank',
      },
      { accountId: null },
    ),
  );
}

function registry(
  handle: (e: EventEnvelope, attempt: number) => Promise<DeliveryResult>,
  maxAttempts = 3,
) {
  return new CompositeRegistry([
    {
      name: 'test-subscriber',
      eventTypes: ['AccountRegistered'],
      maxAttempts,
      handle: (e, i) => handle(e, i.attempt),
    },
  ]);
}

async function delivery() {
  return withTx(pool, systemContext('test'), async (tx) => {
    const { rows } = await tx.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      next_attempt_at: Date | null;
    }>(
      `SELECT status, attempts, last_error, next_attempt_at FROM platform.event_deliveries WHERE subscriber = 'test-subscriber'`,
    );
    return rows[0];
  });
}

const makeDue = () =>
  withTx(pool, systemContext('test'), (tx) =>
    tx.query(`UPDATE platform.event_deliveries SET next_attempt_at = now()`),
  );

describe('event delivery', () => {
  it('does not publish events from a rolled-back transaction', async () => {
    await expect(
      withTx(pool, systemContext('test'), async (tx) => {
        await publishEvent(
          tx,
          systemContext('test'),
          AccountRegistered,
          { accountId: '7d1f6c2a-3b4e-4f5a-8b6c-9d0e1f2a3b09', code: 'X', name: 'X', kind: 'bank' },
          { accountId: null },
        );
        throw new Error('business change failed');
      }),
    ).rejects.toThrow('business change failed');
    expect(
      await relayOutbox(
        pool,
        registry(async () => undefined),
      ),
    ).toBe(0);
  });

  it('relays and delivers an event with its full envelope', async () => {
    const event = await emit();
    const received: EventEnvelope[] = [];
    const reg = registry(async (e) => {
      received.push(e);
    });
    expect(await relayOutbox(pool, reg)).toBe(1);
    expect(await relayOutbox(pool, reg)).toBe(0);
    expect(await dispatchDue(pool, reg)).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
    expect((await delivery())?.status).toBe('delivered');
  });

  it('retries with back-off, dead-letters after the maximum attempts, and replays', async () => {
    await emit();
    let calls = 0;
    const reg = registry(async () => {
      calls += 1;
      throw new Error(`endpoint down (${calls})`);
    }, 2);
    await relayOutbox(pool, reg);

    await dispatchDue(pool, reg);
    let d = await delivery();
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_error: 'endpoint down (1)' });
    expect(d!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 5_000);
    expect(await dispatchDue(pool, reg), 'not due yet').toBe(0);

    await makeDue();
    await dispatchDue(pool, reg);
    d = await delivery();
    expect(d).toMatchObject({ status: 'dead', attempts: 2, last_error: 'endpoint down (2)' });

    const replayed = await withTx(pool, systemContext('test'), (tx) =>
      replayDeadDeliveries(tx, { subscriber: 'test-subscriber' }),
    );
    expect(replayed).toBe(1);
    const ok = registry(async () => undefined, 2);
    await dispatchDue(pool, ok);
    expect((await delivery())?.status).toBe('delivered');
  });

  it('defers without using up an attempt', async () => {
    await emit();
    const reg = registry(async () => ({ defer: { delayMs: 60_000, reason: 'switched off' } }));
    await relayOutbox(pool, reg);
    await dispatchDue(pool, reg);
    const d = await delivery();
    expect(d).toMatchObject({
      status: 'pending',
      attempts: 0,
      last_error: 'deferred: switched off',
    });
  });

  it('dead-letters deliveries for subscribers that no longer exist', async () => {
    await emit();
    await relayOutbox(
      pool,
      registry(async () => undefined),
    );
    await dispatchDue(pool, new CompositeRegistry());
    expect((await delivery())?.status).toBe('dead');
  });
});
