/**
 * Increment 16d: sanctions screening at change and refund (E14-F03-S02) against the stack's synthetic list, and the
 * delivery provider's receipts (E14-F03-S03). Nobody here is a real person and the list entry is invented.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, requireEnv, resetDatabase, type TestContext } from './helpers';
import { publishedStack, send, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
let underwriter: string;
let finance: string;
let provider: string;
let supervisor: string;
let n = 0;

const post = (url: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  send(t, 'POST', url, token, body, headers);
const get = (url: string, token: string) => send(t, 'GET', url, token);

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

async function sell(
  traveller: { firstName: string; lastName: string; dateOfBirth: string },
  purchaser = 'Pat Payer',
) {
  const q = await post(
    '/v1/quotes',
    st.tokens.partner,
    st.quoteBody({ travellers: [{ ...traveller, costPerTraveller: '4200' }] }),
  );
  expect(q.statusCode, q.body).toBe(201);
  const b = await post(
    `/v1/quotes/${q.json().id}/bind`,
    st.tokens.partner,
    {
      ableToTravel: true,
      acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Pat Payer' },
      payment: { reference: `PAY-SCR-${Date.now()}-${n++}`, amount: q.json().premium.total },
      purchaser: { name: purchaser, email: 'payer@example.com' },
    },
    { 'idempotency-key': `scr-${Date.now()}-${n++}` },
  );
  expect(b.statusCode, b.body).toBe(201);
  const view = (await get(`/v1/policies/${b.json().id}`, st.tokens.partner)).json();
  return { id: b.json().id as string, travellerId: view.record.travellers[0].id as string };
}

const preview = (id: string, request: unknown) =>
  post(`/v1/policies/${id}/servicing/preview`, st.tokens.partner, request);
const apply = (id: string, request: unknown, confirmAmount: string) =>
  post(
    `/v1/policies/${id}/servicing`,
    st.tokens.partner,
    { request, confirmAmount },
    { 'idempotency-key': `svc-${Date.now()}-${n++}` },
  );
const rename = (travellerId: string) => ({
  type: 'correct',
  reason: 'Name misspelt',
  travellers: [{ travellerId, firstName: 'Zorbek', lastName: 'Testburg' }],
});
const holds = async (policyId: string) =>
  (
    (await get('/v1/referrals?kind=sanctions', underwriter)).json().items as {
      id: string;
      caseRef: string;
      stage: string;
      status: string;
    }[]
  ).filter((r) => r.caseRef.includes(policyId));
const decide = (id: string, decision: 'approved' | 'declined') =>
  post(`/v1/referrals/${id}/decision`, underwriter, {
    decision,
    reason: 'Checked the details against the list entry.',
  });

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
  underwriter = st.tokens.uw1;
  finance = await t.idp.token({ roles: ['finance_analyst'], sub: 'fin-1', name: 'Finn Finance' });
  provider = await t.idp.token({ roles: ['delivery_provider'], sub: 'svc-mail' });
  supervisor = await t.idp.token({
    roles: ['ops_supervisor'],
    sub: 'ops-1',
    name: 'Sam Supervisor',
  });
}, 300_000);
afterAll(async () => t.close());

describe('screening at change (E14-F03-S02)', () => {
  it('holds a change that would put a possible match on the policy, until a person clears it', async () => {
    const p = await sell({ firstName: 'Clean', lastName: 'Person', dateOfBirth: '1970-03-12' });
    const pv = await preview(p.id, rename(p.travellerId));
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json().allowed).toBe(false);
    expect(pv.json().problems[0]).toMatch(/possible sanctions match must be reviewed.*referral/);
    const [hold, ...more] = await holds(p.id);
    expect(more).toEqual([]);
    expect(hold).toMatchObject({ stage: 'change', status: 'open' });
    // Trying to make it anyway is refused and does not raise a second hold.
    expect((await apply(p.id, rename(p.travellerId), '0.00')).statusCode).toBe(412);
    expect(await holds(p.id)).toHaveLength(1);
    expect((await decide(hold!.id, 'approved')).statusCode).toBe(200);
    const again = (await preview(p.id, rename(p.travellerId))).json();
    expect(again.problems).toEqual([]);
    const done = await apply(p.id, rename(p.travellerId), again.confirmAmount);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().policy.record.travellers[0]).toMatchObject({
      firstName: 'Zorbek',
      lastName: 'Testburg',
    });
  });

  it('keeps refusing once a person has confirmed the match', async () => {
    const p = await sell({ firstName: 'Other', lastName: 'Person', dateOfBirth: '1970-03-12' });
    await preview(p.id, rename(p.travellerId));
    const [hold] = await holds(p.id);
    expect((await decide(hold!.id, 'declined')).statusCode).toBe(200);
    expect((await preview(p.id, rename(p.travellerId))).json().problems[0]).toMatch(
      /has been confirmed/,
    );
  });
});

describe('screening at refund (E14-F03-S02)', () => {
  const refundRecord = async (policyId: string) =>
    (
      (await get('/v1/premium-records', finance)).json().items as {
        id: string;
        policyId: string;
        type: string;
        status: string;
        issues: string[];
      }[]
    ).find((r) => r.policyId === policyId && r.type === 'cancellation')!;
  const cancel = async (policyId: string) => {
    const request = { type: 'cancel', reason: 'Plans changed', noLoss: true };
    const pv = (await preview(policyId, request)).json();
    const done = await apply(policyId, request, pv.confirmAmount);
    expect(done.statusCode, done.body).toBe(200);
  };

  it('cancels, but holds the refund from billing while a match on the payer is reviewed, then releases it', async () => {
    const p = await sell(
      { firstName: 'Quiet', lastName: 'Traveller', dateOfBirth: '1985-01-01' },
      'Zorbek Testburg',
    );
    await cancel(p.id);
    const held = await refundRecord(p.id);
    expect(held.status).toBe('held');
    const [hold] = await holds(p.id);
    expect(hold).toMatchObject({ stage: 'refund', status: 'open' });
    expect(held.issues.join(' ')).toContain(
      `Refund held for sanctions review (referral ${hold!.id}).`,
    );
    // Recalculating does not release it.
    expect(
      (await post(`/v1/premium-records/${held.id}/recalculate`, finance, {}))
        .json()
        .issues.join(' '),
    ).toContain('sanctions review');
    expect((await decide(hold!.id, 'approved')).statusCode).toBe(200);
    expect((await refundRecord(p.id)).issues.join(' ')).not.toContain('sanctions');
  });

  it('says not to pay a confirmed match, and holds nothing for people who do not match', async () => {
    const p = await sell(
      { firstName: 'Still', lastName: 'Traveller', dateOfBirth: '1986-01-01' },
      'Zorbek Testburg',
    );
    await cancel(p.id);
    const [hold] = await holds(p.id);
    await decide(hold!.id, 'declined');
    const record = await refundRecord(p.id);
    const recalculated = (
      await post(`/v1/premium-records/${record.id}/recalculate`, finance, {})
    ).json();
    expect(recalculated.status).toBe('held');
    expect(recalculated.issues.join(' ')).toContain('Do not pay');
    const clean = await sell({
      firstName: 'Plain',
      lastName: 'Traveller',
      dateOfBirth: '1987-01-01',
    });
    await cancel(clean.id);
    expect(await holds(clean.id)).toEqual([]);
    expect((await refundRecord(clean.id)).issues.join(' ')).not.toContain('sanctions');
  });
});

describe('delivery receipts (E14-F03-S03)', () => {
  it('records arrival and bounces, ignores what does not fit, and puts a bounce in the queue', async () => {
    const p = await sell({ firstName: 'Mail', lastName: 'Reader', dateOfBirth: '1990-01-01' });
    const rows = await asOwner(async (c) => {
      await c.query(
        `UPDATE documents.deliveries SET status = 'sent', delivered_at = now(), attempts = 1, next_attempt_at = NULL WHERE channel = 'email' AND document_id IN (SELECT id FROM documents.documents WHERE policy_id = $1)`,
        [p.id],
      );
      return (
        await c.query<{ id: string }>(
          `SELECT x.id FROM documents.deliveries x JOIN documents.documents d ON d.id = x.document_id WHERE d.policy_id = $1 AND x.channel = 'email' ORDER BY x.id`,
          [p.id],
        )
      ).rows;
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const at = new Date().toISOString();
    const receipts = [
      { deliveryId: rows[0]!.id, status: 'delivered', at },
      { deliveryId: rows[1]!.id, status: 'bounced', at, detail: 'Mailbox does not exist' },
      { deliveryId: '00000000-0000-4000-8000-000000000000', status: 'delivered', at },
    ];
    const res = await post('/v1/delivery-receipts', provider, { receipts });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      recorded: 2,
      ignored: [{ deliveryId: '00000000-0000-4000-8000-000000000000' }],
    });
    expect(
      (await post('/v1/delivery-receipts', provider, { receipts: receipts.slice(0, 2) })).json()
        .recorded,
    ).toBe(0);
    const docs = (await get(`/v1/policies/${p.id}/documents`, st.tokens.partner)).json().items as {
      deliveries: {
        id: string;
        status: string;
        receipt: string | null;
        lastError: string | null;
      }[];
    }[];
    const all = docs.flatMap((d) => d.deliveries);
    expect(all.find((d) => d.id === rows[0]!.id)).toMatchObject({
      status: 'sent',
      receipt: 'delivered',
    });
    expect(all.find((d) => d.id === rows[1]!.id)).toMatchObject({
      status: 'failed',
      receipt: 'bounced',
      lastError: 'The provider reported the message bounced: Mailbox does not exist',
    });
    const queue = (await get('/v1/tasks?source=delivery_failure', supervisor)).json();
    expect(queue.items.map((x: { sourceId: string }) => x.sourceId)).toContain(rows[1]!.id);
    expect((await post('/v1/delivery-receipts', st.tokens.partner, { receipts })).statusCode).toBe(
      403,
    );
  });
});
