/**
 * Increment 18: launch readiness by state (E16-F01-S01) and the four go-live sign-offs (E16-F02-S01), over the
 * synthetic published stack. Nothing here is a real filing or a real approval.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, requireEnv, resetDatabase, type TestContext } from './helpers';
import { publishedStack, send, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
let people: Record<'product' | 'actuarial' | 'compliance' | 'finance' | 'both', string>;

const get = async (token: string, states = 'DE') => {
  const res = await send(t, 'GET', `/v1/launch-readiness?states=${states}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const sign = (
  token: string,
  area: string,
  reportHash: string,
  decision = 'signed',
  states = ['DE'],
) =>
  send(t, 'POST', '/v1/launch-readiness/signoffs', token, {
    states,
    area,
    decision,
    reportHash,
    note: 'Checked the report for the launch.',
  });

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
  people = {
    product: st.tokens.product,
    actuarial: st.tokens.analyst,
    compliance: st.tokens.compliance,
    finance: await t.idp.token({ roles: ['finance_analyst'], sub: 'fin-1', name: 'Finn Finance' }),
    both: await t.idp.token({
      roles: ['product_manager', 'finance_analyst'],
      sub: 'two-hats',
      name: 'Two Hats',
    }),
  };
}, 300_000);
afterAll(async () => t.close());

describe('launch readiness (E16-F01-S01)', () => {
  it('says for each state what is met and what is missing', async () => {
    const report = await get(people.compliance, 'DE,NY');
    expect(report.states).toEqual(['DE', 'NY']);
    const [de, ny] = report.byState;
    expect(ny).toMatchObject({
      state: 'NY',
      ready: false,
      plans: [],
      checks: [{ code: 'plan', passed: false }],
    });
    expect(de.plans.length).toBeGreaterThan(0);
    const codes = de.plans[0].checks.map((c: { code: string }) => c.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'eligibility_rules',
        'manual_TCAN',
        'parity_TCAN',
        'manual_filing_TCAN',
        'schedule_template',
        'schedule_filing',
      ]),
    );
    for (const code of ['eligibility_rules', 'manual_TCAN', 'parity_TCAN', 'schedule_template']) {
      expect(
        de.plans[0].checks.find((c: { code: string }) => c.code === code),
        code,
      ).toMatchObject({ passed: true });
    }
    expect(report.ready).toBe(false);
    expect(report.goLiveApproved).toBe(false);
    expect((await send(t, 'GET', '/v1/launch-readiness', st.tokens.partner)).statusCode).toBe(403);
  });

  it('refuses a signature while a state is not ready', async () => {
    const report = await get(people.product, 'NY');
    const res = await sign(people.product, 'product', report.reportHash, 'signed', ['NY']);
    expect(res.statusCode, res.body).toBe(412);
  });
});

describe('go-live sign-off (E16-F02-S01)', () => {
  /** Files whatever the report still asks for, as approved synthetic filings, so the sign-off can be exercised. */
  async function fileEverything() {
    await asOwner(async (c) => {
      await c.query(`INSERT INTO compliance.filings (state, insurer, item_type, item_id, item_reference, status, submitted_on, decided_on, effective_from, created_by)
        SELECT 'DE', f.insurer, 'form_edition', f.id, f.form_number || ' ed. ' || f.edition, 'approved', '2025-01-01', '2025-02-01', '2025-03-01', 'synthetic'
          FROM studio.form_editions f
         WHERE EXISTS (SELECT 1 FROM plans.plans p WHERE p.state = 'DE' AND f.id IN (p.schedule_edition_id, p.policy_edition_id))
           AND NOT EXISTS (SELECT 1 FROM compliance.filings x WHERE x.state = 'DE' AND x.item_id = f.id AND x.status = 'approved')`);
      await c.query(`INSERT INTO compliance.filings (state, insurer, item_type, item_reference, status, submitted_on, decided_on, effective_from, created_by)
        SELECT DISTINCT 'DE', 'VSC', 'rate_manual', m.code, 'approved', '2025-01-01'::date, '2025-02-01'::date, '2025-03-01'::date, 'synthetic'
          FROM rating.manuals m
         WHERE m.state = 'DE' AND m.status = 'published'
           AND NOT EXISTS (SELECT 1 FROM compliance.filings x WHERE x.state = 'DE' AND x.item_reference = m.code AND x.status = 'approved')`);
    });
  }

  it('needs four different people, each for their own area, on the report as it stands', async () => {
    await fileEverything();
    const report = await get(people.product);
    expect(report.ready, JSON.stringify(report.byState)).toBe(true);
    const h = report.reportHash as string;
    expect((await sign(people.product, 'finance', h)).statusCode).toBe(403);
    expect((await sign(people.both, 'product', h)).statusCode).toBe(200);
    expect((await sign(people.both, 'finance', h)).statusCode).toBe(409);
    expect((await sign(people.actuarial, 'actuarial', h)).statusCode).toBe(200);
    expect((await sign(people.compliance, 'compliance', h)).statusCode).toBe(200);
    const last = await sign(people.finance, 'finance', h);
    expect(last.statusCode, last.body).toBe(200);
    expect(last.json()).toMatchObject({ goLiveApproved: true });
    expect(
      last.json().signoffs.map((s: { area: string; signed: boolean }) => [s.area, s.signed]),
    ).toEqual([
      ['product', true],
      ['actuarial', true],
      ['compliance', true],
      ['finance', true],
    ]);
  });

  it('can be withdrawn, keeps every decision, and lapses when the report changes', async () => {
    const report = await get(people.compliance);
    const withdrawn = await sign(people.compliance, 'compliance', report.reportHash, 'withdrawn');
    expect(withdrawn.json()).toMatchObject({ goLiveApproved: false });
    expect(
      (await sign(people.compliance, 'compliance', report.reportHash)).json().goLiveApproved,
    ).toBe(true);
    // A filing is withdrawn: the report changes, so nobody's signature carries over.
    await asOwner((c) =>
      c.query(
        `UPDATE compliance.filings SET status = 'withdrawn', effective_to = current_date - 1 WHERE state = 'DE' AND item_type = 'rate_manual'`,
      ),
    );
    const changed = await get(people.product);
    expect(changed.reportHash).not.toBe(report.reportHash);
    expect(changed).toMatchObject({ ready: false, goLiveApproved: false });
    expect(changed.signoffs.every((s: { signed: boolean }) => !s.signed)).toBe(true);
    expect((await sign(people.product, 'product', report.reportHash)).statusCode).toBe(409);
    const rows = await asOwner((c) => c.query(`SELECT count(*)::int AS n FROM launch.signoffs`));
    expect(rows.rows[0].n).toBeGreaterThanOrEqual(6);
    await expect(asOwner((c) => c.query(`DELETE FROM launch.signoffs`))).rejects.toThrow();
  });
});
