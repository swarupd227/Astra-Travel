/**
 * E13-F02-S03: account data is separated at every layer.
 * "Automated tests attempt cross-account access on every API and all attempts fail."
 *
 * Every route in the catalogue must declare its tenancy. Every `account` route is probed by partner B
 * against partner A's resources, and every `platform` route is refused to partners. A new route that is
 * not covered by a probe fails this suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
let accountA: string;
let accountB: string;
let tokenA: string;
let tokenB: string;
let subscriptionA: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

beforeEach(async () => {
  await resetDatabase();
  accountA = await insertAccount(t.pool, 'TENANT-A');
  accountB = await insertAccount(t.pool, 'TENANT-B');
  tokenA = await t.idp.token({
    roles: ['partner_developer'],
    accountId: accountA,
    sub: 'svc-partner-a',
  });
  tokenB = await t.idp.token({
    roles: ['partner_developer'],
    accountId: accountB,
    sub: 'svc-partner-b',
  });
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/webhook-subscriptions',
    headers: { ...bearer(tokenA), 'idempotency-key': `tenancy-${Date.now()}` },
    payload: { url: 'https://203.0.113.10/astra/webhooks', eventTypes: ['AccountStatusChanged'] },
  });
  expect(res.statusCode, res.body).toBe(201);
  subscriptionA = res.json().id;
});

type Probe = { method: 'GET' | 'POST' | 'DELETE'; url: () => string; payload?: () => unknown };

/** Partner B attacking partner A's data, one probe per account-scoped route. */
const PROBES: Record<string, Probe[]> = {
  'GET /v1/accounts': [{ method: 'GET', url: () => '/v1/accounts' }],
  'GET /v1/accounts/:accountId': [{ method: 'GET', url: () => `/v1/accounts/${accountA}` }],
  'GET /v1/webhook-subscriptions': [
    { method: 'GET', url: () => '/v1/webhook-subscriptions' },
    { method: 'GET', url: () => `/v1/webhook-subscriptions?accountId=${accountA}` },
  ],
  'POST /v1/webhook-subscriptions': [
    {
      method: 'POST',
      url: () => '/v1/webhook-subscriptions',
      payload: () => ({
        accountId: accountA,
        url: 'https://203.0.113.11/x',
        eventTypes: ['AccountStatusChanged'],
      }),
    },
  ],
  'GET /v1/webhook-subscriptions/:subscriptionId': [
    { method: 'GET', url: () => `/v1/webhook-subscriptions/${subscriptionA}` },
  ],
  'POST /v1/webhook-subscriptions/:subscriptionId/status': [
    {
      method: 'POST',
      url: () => `/v1/webhook-subscriptions/${subscriptionA}/status`,
      payload: () => ({ status: 'paused' }),
    },
  ],
  'DELETE /v1/webhook-subscriptions/:subscriptionId': [
    { method: 'DELETE', url: () => `/v1/webhook-subscriptions/${subscriptionA}` },
  ],
};

describe('route catalogue', () => {
  it('declares a tenancy for every route', () => {
    expect(t.app.routeCatalogue.length).toBeGreaterThan(10);
    for (const r of t.app.routeCatalogue)
      expect(['public', 'self', 'account', 'platform']).toContain(r.tenancy);
  });

  it('has a cross-account probe for every account-scoped route', () => {
    const accountRoutes = t.app.routeCatalogue
      .filter((r) => r.tenancy === 'account')
      .map((r) => `${r.method} ${r.url}`);
    expect(accountRoutes.sort()).toEqual(Object.keys(PROBES).sort());
  });
});

describe('cross-account access', () => {
  it('never lets partner B see or change partner A data', async () => {
    for (const [route, probes] of Object.entries(PROBES)) {
      for (const probe of probes) {
        const res = await t.app.inject({
          method: probe.method,
          url: probe.url(),
          headers: {
            ...bearer(tokenB),
            'idempotency-key': `probe-${Math.random().toString(36).slice(2)}`,
          },
          ...(probe.payload ? { payload: probe.payload() as object } : {}),
        });
        const body = res.body;
        if (res.statusCode === 200) {
          // List endpoints succeed but must contain nothing from account A.
          expect(body, route).not.toContain(accountA);
          expect(body, route).not.toContain(subscriptionA);
        } else {
          expect([403, 404], `${route} answered ${res.statusCode}`).toContain(res.statusCode);
        }
      }
    }
    // A's subscription is untouched.
    const own = await t.app.inject({
      method: 'GET',
      url: `/v1/webhook-subscriptions/${subscriptionA}`,
      headers: bearer(tokenA),
    });
    expect(own.json().status).toBe('active');
  });

  it('refuses every platform route to account-scoped principals', async () => {
    const platformRoutes = t.app.routeCatalogue.filter((r) => r.tenancy === 'platform');
    expect(platformRoutes.length).toBeGreaterThan(5);
    for (const r of platformRoutes) {
      const url = r.url
        .replace(':accountId', accountA)
        .replace(':eventId', '00000000-0000-4000-8000-000000000000')
        .replace(':key', 'api.partner-access');
      const res = await t.app.inject({
        method: r.method as 'GET',
        url,
        headers: bearer(tokenB),
        payload: r.method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });

  it('enforces isolation in the database itself (row-level security)', async () => {
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.account_ids', $1, true)`, [accountB]);
      const visible = await client.query<{ id: string }>('SELECT id FROM platform.accounts');
      expect(visible.rows.map((r) => r.id)).toEqual([accountB]);
      const subs = await client.query('SELECT id FROM integration.webhook_subscriptions');
      expect(subs.rowCount).toBe(0);
      const update = await client.query(
        `UPDATE integration.webhook_subscriptions SET status = 'paused' WHERE id = $1`,
        [subscriptionA],
      );
      expect(update.rowCount).toBe(0);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      const none = await client.query('SELECT id FROM platform.accounts');
      expect(none.rowCount, 'no scope set means no rows').toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('lets a partner see its own account only', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(tokenA) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((a: { id: string }) => a.id)).toEqual([accountA]);
  });
});
