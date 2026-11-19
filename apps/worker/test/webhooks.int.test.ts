/**
 * Webhook delivery over real HTTP: signed payloads, failure counting, retry scheduling and the
 * connect-time block on internal addresses.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountStatusChanged } from '@astra/contracts';
import {
  CompositeRegistry,
  createLogger,
  createPool,
  dispatchDue,
  FeatureFlags,
  publishEvent,
  relayOutbox,
  SecretBox,
  SIGNATURE_HEADER,
  systemContext,
  verifySignature,
  withTx,
  type Pool,
} from '@astra/platform';
import { webhookSource } from '../src/webhooks';

const ownerUrl = process.env.TEST_DATABASE_OWNER_URL!;
let pool: Pool;
let server: Server;
let port: number;
let status = 200;
const received: { headers: IncomingMessage['headers']; body: string }[] = [];
const secrets = new SecretBox({ k: randomBytes(32).toString('base64') }, 'k');
const ctx = systemContext('webhook-test', 'corr-webhook-test');

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!, { max: 4 });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.close();
  await pool.end();
});

let accountId: string;
let subscriptionId: string;
const signingSecret = `whsec_${randomBytes(16).toString('hex')}`;

beforeEach(async () => {
  received.length = 0;
  status = 200;
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query(
    `TRUNCATE platform.event_deliveries, platform.outbox, integration.webhook_subscriptions, platform.accounts CASCADE`,
  );
  await owner.end();
  accountId = randomUUID();
  subscriptionId = randomUUID();
  const sealed = secrets.seal(signingSecret, subscriptionId);
  await withTx(pool, ctx, async (tx) => {
    await tx.query(
      `INSERT INTO platform.accounts (id, code, name, kind, created_by) VALUES ($1, 'HOOKTEST', 'Hook test (synthetic)', 'bank', 'test')`,
      [accountId],
    );
    await tx.query(
      `INSERT INTO integration.webhook_subscriptions (id, account_id, url, event_types, secret_ciphertext, secret_key_id, created_by)
       VALUES ($1, $2, $3, ARRAY['AccountStatusChanged'], $4, $5, 'test')`,
      [subscriptionId, accountId, `http://127.0.0.1:${port}/hook`, sealed.ciphertext, sealed.keyId],
    );
  });
});

function registry(allowPrivate: boolean) {
  return new CompositeRegistry(
    [],
    [
      webhookSource({
        pool,
        secrets,
        flags: new FeatureFlags(pool, 0),
        policy: { allowPrivate },
        logger: createLogger('worker-test', 'fatal'),
      }),
    ],
  );
}

async function emitAndDeliver(reg: CompositeRegistry) {
  await withTx(pool, ctx, (tx) =>
    publishEvent(
      tx,
      ctx,
      AccountStatusChanged,
      { accountId, from: 'active', to: 'suspended', reason: 'test' },
      { accountId },
    ),
  );
  expect(await relayOutbox(pool, reg)).toBe(1);
  await dispatchDue(pool, reg);
}

async function state() {
  return withTx(pool, ctx, async (tx) => {
    const d = await tx.query<{ status: string; attempts: number; last_error: string | null }>(
      `SELECT status, attempts, last_error FROM platform.event_deliveries`,
    );
    const s = await tx.query<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM integration.webhook_subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    return { delivery: d.rows[0], failures: s.rows[0]!.consecutive_failures };
  });
}

describe('webhook delivery', () => {
  it('POSTs the signed event envelope to the subscriber', async () => {
    await emitAndDeliver(registry(true));
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    const event = JSON.parse(body);
    expect(event).toMatchObject({
      type: 'AccountStatusChanged',
      accountId,
      correlationId: 'corr-webhook-test',
    });
    expect(headers['astra-event-id']).toBe(event.id);
    expect(headers['x-correlation-id']).toBe('corr-webhook-test');
    expect(
      verifySignature(signingSecret, headers[SIGNATURE_HEADER.toLowerCase()] as string, body),
    ).toBe(true);
    expect((await state()).delivery?.status).toBe('delivered');
  });

  it('counts failures and schedules a retry when the endpoint answers 5xx', async () => {
    status = 503;
    await emitAndDeliver(registry(true));
    const s = await state();
    expect(s.delivery).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'Endpoint answered HTTP 503',
    });
    expect(s.failures).toBe(1);
  });

  it('refuses to connect to internal addresses in production mode', async () => {
    await emitAndDeliver(registry(false));
    expect(received).toHaveLength(0);
    expect((await state()).delivery?.last_error).toMatch(/https|private|internal|Blocked/i);
  });
});
