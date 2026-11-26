/**
 * Increment 16a: the audit trace (E10-F02-S01), statutory data (E10-F02-S02) and account reports (E12-F02-S01),
 * built from real quotes, binds and a cancellation through the API. Every plan, rate, person and amount is synthetic.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, requireEnv, resetDatabase, type TestContext } from './helpers';
import { publishedStack, send, today, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
let finance: string;
let supervisor: string;
let n = 0;

const policies: { id: string; number: string; premium: string }[] = [];

async function sell(selection: string[]) {
  // A different traveller each time: the platform refuses a second policy for the same person and dates.
  const traveller = { firstName: `Trav${policies.length}`, lastName: 'Report', dateOfBirth: `198${policies.length}-05-05`, costPerTraveller: '4200' };
  const q = await send(t, 'POST', '/v1/quotes', st.tokens.partner, st.quoteBody({ selection, travellers: [traveller] }));
  expect(q.statusCode, q.body).toBe(201);
  const amount = q.json().premium.total as string;
  const b = await send(
    t,
    'POST',
    `/v1/quotes/${q.json().id}/bind`,
    st.tokens.partner,
    { ableToTravel: true, acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: 'Pat Sample' }, payment: { reference: `PAY-RPT-${Date.now()}-${n++}`, amount }, purchaser: { name: 'Pat Sample', email: 'pat@example.com' } },
    { 'idempotency-key': `rpt-${Date.now()}-${n++}` },
  );
  expect(b.statusCode, b.body).toBe(201);
  return { id: b.json().id as string, number: b.json().number as string, premium: amount };
}

const get = (url: string, token: string) => send(t, 'GET', url, token);
const cents = (s: string) => Math.round(Number(s) * 100);
const period = () => `from=${today()}&to=${today()}`;

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
  finance = await t.idp.token({ roles: ['finance_analyst'], sub: 'fin-1', name: 'Finn Finance' });
  supervisor = await t.idp.token({ roles: ['ops_supervisor'], sub: 'ops-1', name: 'Sam Supervisor' });
  policies.push(await sell([]));
  policies.push(await sell(['trip_interruption']));
  // A quote that is never bought, for the conversion figure.
  expect((await send(t, 'POST', '/v1/quotes', st.tokens.partner, st.quoteBody())).statusCode).toBe(201);
  // The first policy is cancelled in its review period: a full refund.
  const cancel = { type: 'cancel', reason: 'Changed plans in the review period', noLoss: true };
  const pv = await send(t, 'POST', `/v1/policies/${policies[0]!.id}/servicing/preview`, st.tokens.partner, cancel);
  expect(pv.statusCode, pv.body).toBe(200);
  const done = await send(t, 'POST', `/v1/policies/${policies[0]!.id}/servicing`, st.tokens.partner, { request: cancel, confirmAmount: pv.json().confirmAmount }, { 'idempotency-key': `rpt-cancel-${Date.now()}` });
  expect(done.statusCode, done.body).toBe(200);
}, 300_000);
afterAll(async () => t.close());

describe('statutory data (E10-F02-S02)', () => {
  it('reports premium by state, entity and benefit and reconciles to the premium records', async () => {
    const res = await get(`/v1/reports/statutory?${period()}`, finance);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.reconciliation).toMatchObject({ records: 3, premiumDifference: '0.00', taxDifference: '0.00', reconciled: true, unbalancedRecords: [] });
    const [first, second] = policies;
    const net = cents(second!.premium);
    expect(cents(r.reconciliation.recordPremium)).toBe(net);
    expect(cents(r.reconciliation.reportPremium)).toBe(net);
    expect(r.rows.reduce((a: number, x: { premium: string }) => a + cents(x.premium), 0)).toBe(net);
    expect(r.rows.every((x: { state: string; entity: string }) => x.state === 'DE' && ['VSC', 'ABIC', 'UNASSIGNED'].includes(x.entity))).toBe(true);
    expect(r.rows.map((x: { benefit: string }) => x.benefit)).toEqual(expect.arrayContaining(['trip_cancellation', 'trip_interruption']));
    expect(r.byEntity.reduce((a: number, x: { premium: string }) => a + cents(x.premium), 0)).toBe(net);
    expect(cents(first!.premium)).toBeGreaterThan(0);
  });

  it('exports the rows as CSV with the totals, audited, and refuses a bad period or the wrong role', async () => {
    const csv = await get(`/v1/reports/statutory.csv?${period()}`, finance);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe('state,entity,benefit,transactions,policies,premium');
    expect(csv.body).toContain('DIFFERENCE,,reconciled,,,0.00');
    expect((await get(`/v1/reports/statutory?from=${today()}&to=2000-01-01`, finance)).statusCode).toBe(400);
    expect((await get('/v1/reports/statutory?from=yesterday&to=today', finance)).statusCode).toBe(400);
    expect((await get(`/v1/reports/statutory?${period()}`, supervisor)).statusCode).toBe(403);
    const audit = await get('/v1/audit?action=report.exported', st.tokens.compliance);
    expect(audit.statusCode, audit.body).toBe(200);
    expect(audit.json().items.length).toBeGreaterThan(0);
  });
});

describe('account reports (E12-F02-S01)', () => {
  it('shows sales, premium, cancellations and refunds by account, segment, state and benefit', async () => {
    const res = await get(`/v1/reports/accounts?${period()}`, supervisor);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    const sold = cents(policies[0]!.premium) + cents(policies[1]!.premium);
    expect(r.totals).toMatchObject({ policiesSold: 2, cancellations: 1, refunds: 1 });
    expect(cents(r.totals.premiumCharged)).toBe(sold);
    expect(cents(r.totals.premiumRefunded)).toBe(cents(policies[0]!.premium));
    expect(cents(r.totals.netPremium)).toBe(cents(policies[1]!.premium));
    expect(r.byAccount).toHaveLength(1);
    expect(r.byAccount[0].key).toBe(st.accountId);
    expect(r.bySegment.map((x: { label: string }) => x.label)).toEqual(['No segment']);
    expect(r.byState.map((x: { key: string }) => x.key)).toEqual(['DE']);
    const byBenefit = Object.fromEntries(r.byBenefit.map((x: { key: string; netPremium: string }) => [x.key, cents(x.netPremium)]));
    expect(byBenefit.trip_cancellation! + byBenefit.trip_interruption!).toBe(cents(policies[1]!.premium));
    expect(r.conversion).toEqual([{ accountId: st.accountId, account: r.byAccount[0].label, quotes: 3, bound: 2, rate: 0.6667 }]);
    expect(r.takeUp.find((x: { benefit: string }) => x.benefit === 'trip_interruption')).toMatchObject({ policies: 1, of: 2, rate: 0.5 });
    expect(r.takeUp.find((x: { benefit: string }) => x.benefit === 'trip_cancellation')).toMatchObject({ policies: 2, of: 2, rate: 1 });
  });

  it('narrows to one account, and another account has nothing', async () => {
    const other = (await get(`/v1/reports/accounts?${period()}&accountId=${st.accountBId}`, supervisor)).json();
    expect(other.totals).toMatchObject({ policiesSold: 0, netPremium: '0.00' });
    expect(other.byAccount).toEqual([]);
    expect((await get(`/v1/reports/accounts?${period()}`, st.tokens.partner)).statusCode).toBe(403);
    const csv = await get(`/v1/reports/accounts.csv?${period()}`, supervisor);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('group,name,policies_sold');
  });
});

describe('the audit trace (E10-F02-S01)', () => {
  it('traces a premium to its policy, event, plan, forms, rules, manuals and worksheets, and exports it', async () => {
    const records = (await get('/v1/premium-records', finance)).json().items as { id: string; number: string; type: string; policyId: string }[];
    const bind = records.find((r) => r.type === 'bind' && r.policyId === policies[1]!.id)!;
    const res = await get(`/v1/trace/premium-records/${bind.id}?download=true`, st.tokens.compliance);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toContain(`trace-${bind.number}.json`);
    const trace = res.json();
    expect(trace.subject).toEqual({ type: 'premium_record', id: bind.id, label: bind.number });
    expect(trace.policy).toMatchObject({ number: policies[1]!.number, state: 'DE' });
    expect(trace.event).toMatchObject({ type: 'bound' });
    expect(trace.plan).toMatchObject({ code: 'Q-DE', versionId: st.planVersionId });
    expect(trace.plan.sha256).toBeTruthy();
    expect(trace.ruleSet).toMatchObject({ id: st.ruleSetId });
    expect(trace.forms.length).toBeGreaterThan(0);
    expect(trace.forms.every((f: { sha256: string }) => f.sha256.length === 64)).toBe(true);
    expect(trace.manuals.map((m: { benefit: string }) => m.benefit).sort()).toEqual(['TCAN', 'TINT']);
    expect(trace.worksheets.length).toBe(2);
    expect(trace.agents).toEqual([]);
    expect(trace.gaps).toEqual([]);
  });

  it('traces an issued document to its template and versions', async () => {
    const docs = (await get(`/v1/policies/${policies[1]!.id}/documents`, st.tokens.compliance)).json().items as { id: string; kind: string; status: string }[];
    expect(docs.length).toBeGreaterThan(0);
    const schedule = docs.find((d) => d.kind === 'schedule') ?? docs[0]!;
    const trace = (await get(`/v1/trace/documents/${schedule.id}`, st.tokens.compliance)).json();
    expect(trace.subject.type).toBe('document');
    expect(trace.plan).toMatchObject({ code: 'Q-DE' });
    if (schedule.kind === 'schedule') expect(trace.templates[0]).toMatchObject({ kind: 'schedule', variableMapVersion: expect.any(Number) });
    expect(trace.manuals.length).toBeGreaterThan(0);
  });

  it('is only for people who may read the audit trail, and every trace is recorded', async () => {
    const records = (await get('/v1/premium-records', finance)).json().items as { id: string }[];
    expect((await get(`/v1/trace/premium-records/${records[0]!.id}`, finance)).statusCode).toBe(403);
    expect((await get(`/v1/trace/premium-records/00000000-0000-4000-8000-000000000000`, st.tokens.compliance)).statusCode).toBe(404);
    const c = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL') });
    await c.connect();
    try {
      await c.query(`SET app.account_ids = '*'`);
      const rows = await c.query(`SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'trace.taken'`);
      expect(rows.rows[0].n).toBeGreaterThanOrEqual(2);
    } finally {
      await c.end();
    }
  });
});
