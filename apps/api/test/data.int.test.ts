/**
 * Increment 16b: the reporting model and catalogue (E12-F01-S01), loads to the data platform with quality checks
 * (E12-F01-S02) and the claims feed (E12-F01-S03), from real binds and changes through the API. Synthetic data.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA_CATALOGUE } from '@astra/contracts';
import { createTestApp, requireEnv, resetDatabase, type TestContext } from './helpers';
import { addDays, publishedStack, send, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
let admin: string;
let claims: string;
let n = 0;
let policy: { id: string; number: string; premium: string };

async function sell(name: string) {
  const q = await send(t, 'POST', '/v1/quotes', st.tokens.partner, st.quoteBody({ travellers: [{ firstName: name, lastName: 'Feed', dateOfBirth: `197${n}-04-04`, costPerTraveller: '4200' }] }));
  expect(q.statusCode, q.body).toBe(201);
  const premium = q.json().premium.total as string;
  const b = await send(
    t,
    'POST',
    `/v1/quotes/${q.json().id}/bind`,
    st.tokens.partner,
    { ableToTravel: true, acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Pat Sample' }, payment: { reference: `PAY-DATA-${Date.now()}-${n++}`, amount: premium }, purchaser: { name: 'Pat Sample', email: 'pat@example.com' } },
    { 'idempotency-key': `data-${Date.now()}-${n}` },
  );
  expect(b.statusCode, b.body).toBe(201);
  return { id: b.json().id as string, number: b.json().number as string, premium };
}

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

const file = async (loadId: string, name: string) => {
  const res = await get(`/v1/data-loads/${loadId}/files/${name}`, admin);
  expect(res.statusCode, res.body).toBe(200);
  return res.body
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
  admin = st.tokens.admin;
  claims = await t.idp.token({ roles: ['cover_verifier'], sub: 'svc-claims' });
  policy = await sell('Ada');
}, 300_000);
afterAll(async () => t.close());

describe('the reporting model and its catalogue (E12-F01-S01)', () => {
  it('publishes definitions that match the database views column for column', async () => {
    const res = await get('/v1/data-catalogue', admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().entities.map((e: { name: string }) => e.name)).toEqual(['plans', 'accounts', 'policies', 'travellers', 'trips', 'benefits', 'premiums', 'transactions']);
    const columns = await asOwner((c) => c.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'analytics'`));
    for (const e of DATA_CATALOGUE) {
      const inView = columns.rows.filter((c) => c.table_name === e.name).map((c) => c.column_name).sort();
      expect(inView, e.name).toEqual(e.fields.map((f) => f.name).sort());
      for (const k of e.key) expect(e.fields.some((f) => f.name === k && f.required), `${e.name}.${k}`).toBe(true);
    }
    expect((await get('/v1/data-catalogue', st.tokens.partner)).statusCode).toBe(403);
  });
});

describe('loads to the data platform (E12-F01-S02)', () => {
  let firstLoad = '';

  it('loads changed rows with quality checks, leaving out personal data, and says how long they waited', async () => {
    const waiting = (await get('/v1/data-loads', admin)).json();
    expect(waiting.pending.count).toBeGreaterThan(0);
    expect(waiting.pending.withinTarget).toBe(true);
    expect(waiting.targetSeconds).toBe(900);
    const run = await send(t, 'POST', '/v1/data-loads', admin);
    expect(run.statusCode, run.body).toBe(200);
    const load = run.json().load;
    expect(load).toMatchObject({ status: 'delivered', trigger: 'manual', rejected: 0 });
    expect(load.maxLagSeconds).toBeLessThan(900);
    expect(load.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
    expect(load.files.map((f: { name: string }) => f.name)).toEqual(['plans.ndjson', 'accounts.ndjson', 'policies.ndjson', 'travellers.ndjson', 'trips.ndjson', 'benefits.ndjson', 'premiums.ndjson', 'transactions.ndjson']);
    firstLoad = load.id;
    const policies = await file(load.id, 'policies.ndjson');
    expect(policies).toEqual([expect.objectContaining({ policy_number: policy.number, premium_total: policy.premium, state: 'DE' })]);
    const travellers = await file(load.id, 'travellers.ndjson');
    expect(Object.keys(travellers[0]!).sort()).toEqual(['account_id', 'policy_id', 'traveller_id']);
    for (const f of load.files as { name: string }[]) expect(JSON.stringify(await file(load.id, f.name))).not.toMatch(/Ada|1970-04-04/);
    const premiums = await file(load.id, 'premiums.ndjson');
    expect(premiums[0]).toMatchObject({ premium: policy.premium, type: 'bind' });
  });

  it('loads each change once, and a change to a policy brings its current rows', async () => {
    expect((await send(t, 'POST', '/v1/data-loads', admin)).json().load).toBeNull();
    const change = { type: 'change_destinations', reason: 'Going somewhere else', destinations: [{ country: 'IT', region: 'Southern Europe' }] };
    const pv = await send(t, 'POST', `/v1/policies/${policy.id}/servicing/preview`, st.tokens.partner, change);
    expect(pv.statusCode, pv.body).toBe(200);
    const done = await send(t, 'POST', `/v1/policies/${policy.id}/servicing`, st.tokens.partner, { request: change, confirmAmount: pv.json().confirmAmount }, { 'idempotency-key': `data-change-${Date.now()}` });
    expect(done.statusCode, done.body).toBe(200);
    const load = (await send(t, 'POST', '/v1/data-loads', admin)).json().load;
    expect(load.id).not.toBe(firstLoad);
    expect((await file(load.id, 'transactions.ndjson')).map((x) => x.transaction_type)).toEqual(['change_destinations']);
    expect(await file(load.id, 'trips.ndjson')).toEqual([expect.objectContaining({ destinations: [{ country: 'IT', region: 'Southern Europe' }] })]);
    const list = (await get('/v1/data-loads', admin)).json();
    expect(list.items).toHaveLength(2);
    expect(list.pending).toMatchObject({ count: 0, oldestSeconds: null, withinTarget: true });
    await expect(asOwner((c) => c.query(`UPDATE integration.data_loads SET rejected = 0`))).rejects.toThrow();
    expect((await get(`/v1/data-loads/${load.id}/files/secrets.ndjson`, admin)).statusCode).toBe(404);
  });

  it('search finds a changed trip by where it goes now, not where it was first quoted', async () => {
    const search = async (q: string) => (await get(`/v1/search?q=${encodeURIComponent(q)}`, st.tokens.uw1)).json().items.map((i: { number: string }) => i.number);
    expect(await search('southern europe')).toEqual([policy.number]);
    expect(await search('"FR"')).toEqual([]);
  });
});

describe('the claims feed (E12-F01-S03)', () => {
  it('gives policies with travellers, the current trip, benefits, limits and cover dates', async () => {
    const res = await get('/v1/claims-feed', claims);
    expect(res.statusCode, res.body).toBe(200);
    const feed = res.json();
    expect(feed.format).toBe('astra.claims.v1');
    expect(feed.policies).toHaveLength(1);
    const p = feed.policies[0];
    expect(p).toMatchObject({ policyNumber: policy.number, status: 'active', planCode: 'Q-DE', state: 'DE', trip: { departureDate: st.dates.departure, destinations: [{ country: 'IT', region: 'Southern Europe' }] } });
    expect(p.travellers).toEqual([expect.objectContaining({ firstName: 'Ada', lastName: 'Feed', dateOfBirth: '1970-04-04' })]);
    expect(p.benefits.length).toBeGreaterThan(0);
    expect(p.benefits[0]).toMatchObject({ code: expect.any(String), coverageStart: expect.stringMatching(/^\d{4}-/), limits: expect.anything() });
    expect(feed.certificates).toEqual([]);
    expect(feed.next.more).toBe(false);
  });

  it('then gives only what changed, with a higher version', async () => {
    const first = (await get('/v1/claims-feed', claims)).json();
    const nothing = (await get(`/v1/claims-feed?policyCursor=${first.next.policyCursor}`, claims)).json();
    expect(nothing.policies).toEqual([]);
    expect(nothing.next.policyCursor).toBe(first.next.policyCursor);
    const second = await sell('Grace');
    const newDeparture = addDays(st.dates.departure, 1);
    const change = { type: 'change_dates', reason: 'Flight moved', departureDate: newDeparture, returnDate: addDays(st.dates.return, 1) };
    const pv = await send(t, 'POST', `/v1/policies/${policy.id}/servicing/preview`, st.tokens.partner, change);
    expect(pv.statusCode, pv.body).toBe(200);
    expect((await send(t, 'POST', `/v1/policies/${policy.id}/servicing`, st.tokens.partner, { request: change, confirmAmount: pv.json().confirmAmount }, { 'idempotency-key': `data-dates-${Date.now()}` })).statusCode).toBe(200);
    const delta = (await get(`/v1/claims-feed?policyCursor=${first.next.policyCursor}`, claims)).json();
    expect(delta.policies.map((p: { policyNumber: string }) => p.policyNumber)).toEqual([second.number, policy.number]);
    const changed = delta.policies.find((p: { policyNumber: string }) => p.policyNumber === policy.number);
    expect(changed.version).toBeGreaterThan(first.policies[0].version);
    expect(changed.trip).toMatchObject({ departureDate: newDeparture, destinations: [{ country: 'IT', region: 'Southern Europe' }] });
    const page = (await get('/v1/claims-feed?limit=1', claims)).json();
    expect(page.policies).toHaveLength(1);
    expect(page.next.more).toBe(true);
  });

  it('is only for the claims application', async () => {
    expect((await get('/v1/claims-feed', st.tokens.partner)).statusCode).toBe(403);
    expect((await get('/v1/claims-feed', st.tokens.uw1)).statusCode).toBe(403);
    expect((await get('/v1/claims-feed?certificateCursor=nonsense', claims)).statusCode).toBe(400);
  });
});
