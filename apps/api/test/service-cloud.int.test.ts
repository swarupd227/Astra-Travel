/**
 * Increment 16c: Salesforce Service Cloud (E14-F02): the customer view, servicing actions that record the Service
 * Cloud user and case, document resend, and the alert when an event cannot be delivered. No Service Cloud is
 * connected: the calls it would make are made here. Synthetic data.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, requireEnv, resetDatabase, type TestContext } from './helpers';
import { publishedStack, send, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
let rep: string;
let supervisor: string;
let policy: { id: string; number: string };
const sc = { 'x-service-cloud-user': '005XX000001Sv6AAE', 'x-service-cloud-case': 'CASE-00012345' };

const post = (url: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  send(t, 'POST', url, token, body, headers);

async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL') });
  await c.connect();
  try {
    await c.query(`SET app.account_ids = '*'`);
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
  rep = await t.idp.token({ roles: ['service_rep'], sub: 'rep-1', name: 'Riley Rep' });
  supervisor = await t.idp.token({
    roles: ['ops_supervisor'],
    sub: 'ops-1',
    name: 'Sam Supervisor',
  });
  const q = await post(
    '/v1/quotes',
    st.tokens.partner,
    st.quoteBody({
      travellers: [
        {
          firstName: 'Cara',
          lastName: 'Customer',
          dateOfBirth: '1982-02-02',
          costPerTraveller: '4200',
        },
      ],
    }),
  );
  const b = await post(
    '/v1/quotes/' + q.json().id + '/bind',
    st.tokens.partner,
    {
      ableToTravel: true,
      acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Cara Customer' },
      payment: { reference: `PAY-SC-${Date.now()}`, amount: q.json().premium.total },
      purchaser: { name: 'Cara Customer', email: 'cara@example.com' },
    },
    { 'idempotency-key': `sc-${Date.now()}` },
  );
  expect(b.statusCode, b.body).toBe(201);
  policy = { id: b.json().id, number: b.json().number };
}, 300_000);
afterAll(async () => t.close());

describe('the customer view (E14-F02-S01)', () => {
  it('returns cover, documents and history by policy number or by name and date of birth, and audits without the details', async () => {
    const byNumber = await post(
      '/v1/service/customer-view',
      rep,
      { policyNumber: policy.number.toLowerCase() },
      sc,
    );
    expect(byNumber.statusCode, byNumber.body).toBe(200);
    const view = byNumber.json();
    expect(view.policies).toHaveLength(1);
    expect(view.policies[0].policy).toMatchObject({ number: policy.number, status: 'active' });
    expect(view.policies[0].policy.record.benefits.length).toBeGreaterThan(0);
    expect(view.policies[0].policy.history.map((h: { type: string }) => h.type)).toEqual(['bound']);
    expect(view.policies[0].documents.length).toBeGreaterThan(0);
    expect(view.truncated).toBe(false);
    const byName = (
      await post('/v1/service/customer-view', rep, {
        lastName: 'CUSTOMER',
        dateOfBirth: '1982-02-02',
      })
    ).json();
    expect(byName.policies.map((p: { policy: { number: string } }) => p.policy.number)).toEqual([
      policy.number,
    ]);
    expect(
      (
        await post('/v1/service/customer-view', rep, {
          lastName: 'Customer',
          dateOfBirth: '1999-09-09',
        })
      ).json().policies,
    ).toEqual([]);
    // The audit log is never emptied, so only the entries about this policy are read.
    const audit = await asOwner((c) =>
      c.query(
        `SELECT data FROM audit.audit_log WHERE action = 'customer_view.read' AND data->'policies' ? $1 ORDER BY seq`,
        [policy.number],
      ),
    );
    expect(audit.rows[0].data).toMatchObject({
      by: 'policy_number',
      policies: [policy.number],
      externalCase: {
        userId: sc['x-service-cloud-user'],
        caseReference: sc['x-service-cloud-case'],
      },
    });
    expect(JSON.stringify(audit.rows)).not.toMatch(/Customer|1982-02-02/);
  });

  it('follows the representative’s access: another account finds nothing, and loose requests are refused', async () => {
    expect(
      (
        await post('/v1/service/customer-view', st.tokens.partnerB, { policyNumber: policy.number })
      ).json().policies,
    ).toEqual([]);
    expect(
      (await post('/v1/service/customer-view', rep, { lastName: 'Customer' })).statusCode,
    ).toBe(400);
    expect((await post('/v1/service/customer-view', rep, {})).statusCode).toBe(400);
  });
});

describe('servicing from Service Cloud (E14-F02-S02)', () => {
  it('quotes a change, confirms it and records the Service Cloud user and case on each action', async () => {
    const change = {
      type: 'change_destinations',
      reason: 'Customer called',
      destinations: [{ country: 'ES', region: 'Europe' }],
    };
    const pv = await post(`/v1/policies/${policy.id}/servicing/preview`, rep, change, sc);
    expect(pv.statusCode, pv.body).toBe(200);
    const done = await post(
      `/v1/policies/${policy.id}/servicing`,
      rep,
      { request: change, confirmAmount: pv.json().confirmAmount },
      { ...sc, 'idempotency-key': `sc-change-${Date.now()}` },
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().policy.history.at(-1).data.externalCase).toEqual({
      system: 'service_cloud',
      userId: sc['x-service-cloud-user'],
      caseReference: sc['x-service-cloud-case'],
    });
    const audit = await asOwner((c) =>
      c.query(
        `SELECT action, actor_id, data FROM audit.audit_log WHERE resource_id = $1 AND action IN ('policy.change_quoted', 'policy.changed') ORDER BY seq`,
        [policy.id],
      ),
    );
    expect(
      audit.rows.map((r) => [r.action, r.actor_id, r.data.externalCase.caseReference]),
    ).toEqual([
      ['policy.change_quoted', 'rep-1', 'CASE-00012345'],
      ['policy.changed', 'rep-1', 'CASE-00012345'],
    ]);
  });

  it('refuses half a Service Cloud reference', async () => {
    const change = {
      type: 'change_destinations',
      reason: 'Customer called',
      destinations: [{ country: 'PT', region: 'Europe' }],
    };
    const half = await post(`/v1/policies/${policy.id}/servicing/preview`, rep, change, {
      'x-service-cloud-user': 'someone',
    });
    expect(half.statusCode).toBe(400);
    expect(half.json().errors[0].field).toBe('x-service-cloud-case');
    expect(
      (
        await post(`/v1/policies/${policy.id}/servicing/preview`, rep, change, {
          ...sc,
          'x-service-cloud-case': 'bad case with spaces',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('sends emailed documents again to the address on record', async () => {
    await asOwner((c) =>
      c.query(
        `UPDATE documents.deliveries SET status = 'sent', delivered_at = now(), attempts = 1, next_attempt_at = NULL WHERE channel = 'email'`,
      ),
    );
    const res = await post(
      `/v1/policies/${policy.id}/documents/resend`,
      rep,
      { reason: 'Customer lost the email' },
      sc,
    );
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().queued.length).toBeGreaterThan(0);
    const again = await post(`/v1/policies/${policy.id}/documents/resend`, rep, {
      reason: 'Twice',
    });
    expect(again.json()).toMatchObject({ queued: [], alreadyQueued: res.json().queued.length });
    const rows = await asOwner((c) =>
      c.query(
        `SELECT DISTINCT status, recipient FROM documents.deliveries WHERE channel = 'email'`,
      ),
    );
    expect(rows.rows).toEqual([{ status: 'queued', recipient: 'cara@example.com' }]);
    expect(
      (
        await post(`/v1/policies/${policy.id}/documents/resend`, rep, {
          reason: 'Unknown document',
          documentIds: ['00000000-0000-4000-8000-000000000000'],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(`/v1/policies/${policy.id}/documents/resend`, st.tokens.partnerB, {
          reason: 'Not mine',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('events for Service Cloud (E14-F02-S03)', () => {
  it('publishes the policy events, and an event that cannot be delivered becomes a task', async () => {
    const events = await asOwner((c) =>
      c.query(
        `SELECT type, account_id FROM platform.outbox WHERE type IN ('PolicyBound', 'PolicyChanged') ORDER BY seq`,
      ),
    );
    expect(events.rows.map((r) => r.type)).toEqual(['PolicyBound', 'PolicyChanged']);
    expect(events.rows.every((r) => r.account_id === st.accountId)).toBe(true);
    // The retries and back-off are the dispatcher's, proven in webhooks.int.test.ts; here one delivery has run out of them.
    await asOwner((c) =>
      c.query(
        `INSERT INTO platform.event_deliveries (event_id, subscriber, event_type, account_id, status, attempts, last_error, next_attempt_at)
         SELECT id, 'webhook:service-cloud', type, account_id, 'dead', 8, 'The subscriber answered HTTP 503', NULL FROM platform.outbox WHERE type = 'PolicyChanged'`,
      ),
    );
    const listed = await send(t, 'GET', '/v1/tasks?source=event_delivery', supervisor);
    expect(listed.statusCode, listed.body).toBe(200);
    const queue = listed.json();
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      sourceType: 'event_delivery',
      priority: 'high',
      title: 'Event not delivered: PolicyChanged',
      link: '/operations/events',
      accountId: st.accountId,
    });
    expect(queue.items[0].summary).toContain('after 8 attempts');
    expect((await send(t, 'GET', '/v1/me', supervisor)).statusCode).toBe(200);
    const taken = await send(
      t,
      'PUT',
      `/v1/tasks/event_delivery/${queue.items[0].sourceId}/assignment`,
      supervisor,
      { owner: 'ops-1' },
    );
    expect(taken.statusCode, taken.body).toBe(200);
  });
});
