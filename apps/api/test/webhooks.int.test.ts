/** Webhook subscriptions: SSRF protection, one-time secret, encrypted storage, idempotent replay. */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestApp,
  insertAccount,
  requireEnv,
  resetDatabase,
  type TestContext,
} from './helpers';

let t: TestContext;
let accountId: string;
let partner: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await resetDatabase();
  accountId = await insertAccount(t.pool, 'HOOKS');
  partner = await t.idp.token({ roles: ['partner_developer'], accountId });
});

const subscribe = (
  url: string,
  key = `wh-${Math.random()}`,
  eventTypes = ['AccountStatusChanged'],
) =>
  t.app.inject({
    method: 'POST',
    url: '/v1/webhook-subscriptions',
    headers: { ...bearer(partner), 'idempotency-key': key },
    payload: { url, eventTypes },
  });

describe('webhook subscriptions', () => {
  it.each([
    'http://203.0.113.10/hook',
    'https://localhost/hook',
    'https://127.0.0.1/hook',
    'https://10.1.2.3/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'https://user:pass@203.0.113.10/hook',
  ])('rejects unsafe endpoint %s', async (url) => {
    const res = await subscribe(url);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].field).toBe('url');
  });

  it('rejects unknown event types', async () => {
    const res = await subscribe('https://203.0.113.10/hook', undefined, ['PolicyTeleported']);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('unknown_event_type');
  });

  it('returns the signing secret, stores it encrypted, and replays it for the same key', async () => {
    const first = await subscribe('https://203.0.113.10/hook', 'wh-secret-1');
    expect(first.statusCode, first.body).toBe(201);
    const { signingSecret, id } = first.json();
    expect(signingSecret).toMatch(/^whsec_/);
    expect(first.headers['cache-control']).toBe('no-store');

    const replay = await subscribe('https://203.0.113.10/hook', 'wh-secret-1');
    expect(replay.json()).toEqual(first.json());

    const read = await t.app.inject({
      method: 'GET',
      url: `/v1/webhook-subscriptions/${id}`,
      headers: bearer(partner),
    });
    expect(read.json()).not.toHaveProperty('signingSecret');

    const owner = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL') });
    await owner.connect();
    // Row-level security is forced even for the schema owner, so the inspection needs a scope too.
    await owner.query(`SET app.account_ids = '*'`);
    try {
      const raw = await owner.query(
        `SELECT secret_ciphertext FROM integration.webhook_subscriptions WHERE id = $1`,
        [id],
      );
      expect(raw.rows[0].secret_ciphertext).not.toContain(signingSecret.slice(6));
      const stored = await owner.query(
        `SELECT response_body::text AS body FROM platform.idempotency_keys WHERE key = 'wh-secret-1'`,
      );
      expect(stored.rows[0].body).not.toContain(signingSecret);
    } finally {
      await owner.end();
    }
  });

  it('pauses, resumes and removes a subscription; removed subscriptions cannot change', async () => {
    const { id } = (await subscribe('https://203.0.113.10/hook')).json();
    const pause = await t.app.inject({
      method: 'POST',
      url: `/v1/webhook-subscriptions/${id}/status`,
      headers: bearer(partner),
      payload: { status: 'paused' },
    });
    expect(pause.json().status).toBe('paused');
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-subscriptions/${id}`,
      headers: bearer(partner),
    });
    expect(del.statusCode).toBe(204);
    const resume = await t.app.inject({
      method: 'POST',
      url: `/v1/webhook-subscriptions/${id}/status`,
      headers: bearer(partner),
      payload: { status: 'active' },
    });
    expect(resume.statusCode).toBe(409);
  });

  it('requires staff to name the account', async () => {
    const staff = await t.idp.token({ roles: ['account_manager'] });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/webhook-subscriptions',
      headers: { ...bearer(staff), 'idempotency-key': 'wh-staff-1' },
      payload: { url: 'https://203.0.113.10/hook', eventTypes: ['AccountStatusChanged'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].field).toBe('accountId');
  });
});
