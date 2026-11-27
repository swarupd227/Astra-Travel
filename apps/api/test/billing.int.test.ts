/**
 * Increment 12: premium records, commission with clawback, premium tax, batches with control totals and the
 * billing system's confirmations (E08, E14-F03-S01) through the API and database on a complete published stack
 * (see fixtures.ts). Every rate, percent and amount is SYNTHETIC: the stack's TCAN rate is 2.000 per $100 of trip
 * cost (84.00 for 4200), tax rates and commission percents are test values, not filed or contracted ones.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@astra/platform';
import { FeedProcessor } from '@astra/card';
import {
  FileDropChannel,
  HttpChannel,
  sendNext,
  type BillingChannel,
  type SendOptions,
} from '../../worker/src/billing';
import { createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';
import { publishedStack, send, today, type Stack } from './fixtures';

let t: TestContext;
let st: Stack;
let finance: string;
let billing: string;
const logger = createLogger('billing-test', 'fatal');
const outDir = mkdtempSync(join(tmpdir(), 'astra-billing-'));

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase();
  st = await publishedStack(t);
  finance = await t.idp.token({ roles: ['finance_analyst'], sub: 'fin-1', name: 'Fay Finance' });
  billing = await t.idp.token({ roles: ['billing_system'], sub: 'svc-billing' });
}, 240_000);
afterAll(async () => {
  await t.close();
  rmSync(outDir, { recursive: true, force: true });
});

let n = 0;
async function bindPolicy(over: Record<string, unknown> = {}, first?: string) {
  const name = first ?? `Bill${n++}`;
  const q = await send(
    t,
    'POST',
    '/v1/quotes',
    st.tokens.partner,
    st.quoteBody({
      travellers: [
        {
          firstName: name,
          lastName: 'Billed',
          dateOfBirth: '1980-05-05',
          costPerTraveller: '4200',
        },
      ],
      ...over,
    }),
  );
  expect(q.statusCode, q.body).toBe(201);
  const b = await send(
    t,
    'POST',
    `/v1/quotes/${q.json().id}/bind`,
    st.tokens.partner,
    {
      ableToTravel: true,
      acknowledgement: { disclosureVersion: st.disclosureVersion, acknowledgedBy: name },
      payment: { reference: `PAY-BILL-${Date.now()}-${n++}`, amount: q.json().premium.total },
      purchaser: { name },
    },
    { 'idempotency-key': `bind-bill-${Date.now()}-${n++}` },
  );
  expect(b.statusCode, b.body).toBe(201);
  return b.json() as { id: string; number: string };
}
type Rec = {
  id: string;
  type: string;
  status: string;
  issues: string[];
  premium: string;
  charge: string;
  refund: string;
  retained: string;
  commission: { amount: string; ratePercent: string; rule: string } | null;
  tax: string | null;
  allocation: {
    entity: string;
    arrangement: string | null;
    premium: string;
    tax: string | null;
    taxRatePercent: number | null;
  }[];
  perBenefit: { code: string; premium: string }[];
  perTraveller: { travellerId: string; premium: string }[];
  basis: unknown;
  worksheetIds: string[];
  policyEventSeq: number | null;
  batchId: string | null;
  billingReference: string | null;
  billingReason: string | null;
};
const recordsOf = async (policyId: string) =>
  (await send(t, 'GET', `/v1/policies/${policyId}/premium-records`, st.tokens.admin)).json()
    .items as Rec[];
const sum = (xs: string[]) => Math.round(xs.reduce((a, x) => a + Number(x) * 100, 0)) / 100;

async function asPlatform<T>(
  fn: (
    q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  ) => Promise<T>,
): Promise<T> {
  const c = await t.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.account_ids', '*', true)`);
    const out = await fn((sql, params) => c.query(sql, params));
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

let heldPolicy: { id: string; number: string };

describe('a record for every transaction, held until it can be completed honestly (E08-F01, E08-F02)', () => {
  it('is written with the bind, and held with its reasons while the tax rates and commission rule are missing', async () => {
    heldPolicy = await bindPolicy();
    const [r] = await recordsOf(heldPolicy.id);
    expect(r).toMatchObject({
      type: 'bind',
      status: 'held',
      premium: '84.00',
      charge: '84.00',
      refund: '0.00',
      policyEventSeq: expect.any(Number),
      commission: null,
      tax: null,
    });
    expect(r!.issues.join(' ')).toContain('No premium tax rate is loaded for DE and VSC');
    expect(r!.issues.join(' ')).toContain('no approved commission rule');
    // It links to the rating worksheet and carries the basis and the split.
    expect(r!.worksheetIds).toHaveLength(1);
    expect(r!.perBenefit).toEqual(
      [
        { code: 'trip_cancellation', premium: '84.00' },
        { code: 'trip_interruption', premium: '0.00' },
        { code: 'trip_delay', premium: '0.00' },
      ].filter((b) => r!.perBenefit.some((x) => x.code === b.code)),
    );
    expect(r!.perTraveller).toEqual([{ travellerId: 'T1', premium: '84.00' }]);
    expect(r!.allocation).toMatchObject([
      { entity: 'VSC', arrangement: 'VSC', premium: '84.00', tax: null },
    ]);
    // A held record is not collected into a batch.
    expect((await send(t, 'POST', '/v1/billing/batches', finance, {})).json()).toMatchObject({
      batch: null,
    });
  });

  it('is completed by recalculating once the rates and the rule are configured, and the rule needs a second person', async () => {
    const load = await send(
      t,
      'POST',
      '/v1/reference-data/premium_tax_rates/versions',
      st.tokens.analyst,
      {
        effectiveFrom: '2026-01-01',
        source: 'Synthetic test rates',
        entries: [
          {
            key: 'DE:VSC',
            state: 'DE',
            insurer: 'VSC',
            ratePercent: 2,
            basis: 'Premium tax (synthetic)',
          },
          {
            key: 'DE:ABIC',
            state: 'DE',
            insurer: 'ABIC',
            ratePercent: 3,
            basis: 'Premium tax (synthetic)',
          },
        ],
      },
    );
    expect(load.statusCode, load.body).toBe(201);
    expect(
      (
        await send(
          t,
          'POST',
          `/v1/reference-data/premium_tax_rates/versions/${load.json().id}/decision`,
          st.tokens.compliance,
          { decision: 'approve', reason: 'Test rates.' },
        )
      ).statusCode,
    ).toBe(200);

    const rule = await send(t, 'POST', '/v1/commission-rules', finance, {
      accountId: st.accountId,
      effectiveFrom: '2026-01-01',
      document: { kind: 'flat', percent: 10 },
    });
    expect(rule.statusCode, rule.body).toBe(201);
    expect(rule.json()).toMatchObject({ status: 'draft', version: 1 });
    // The maker cannot approve; neither can a person without the permission.
    expect(
      (await send(t, 'POST', `/v1/commission-rules/${rule.json().id}/approve`, finance, {}))
        .statusCode,
    ).toBe(403);
    // Another finance-capable person with approval rights can.
    const approver = await t.idp.token({
      roles: ['compliance_officer'],
      sub: 'comp-2',
      name: 'Cal Compliance',
    });
    const approved = await send(
      t,
      'POST',
      `/v1/commission-rules/${rule.json().id}/approve`,
      approver,
      {},
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved', approvedBy: 'comp-2' });

    const [held] = await recordsOf(heldPolicy.id);
    const done = await send(t, 'POST', `/v1/premium-records/${held!.id}/recalculate`, finance, {});
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({
      status: 'ready',
      issues: [],
      tax: '1.68',
      commission: { amount: '8.40', ratePercent: '10.0000', rule: 'Flat 10%' },
    });
    expect(done.json().allocation[0]).toMatchObject({
      entity: 'VSC',
      premium: '84.00',
      taxRatePercent: 2,
      tax: '1.68',
    });
    // A record that is not held cannot be recalculated.
    expect(
      (await send(t, 'POST', `/v1/premium-records/${held!.id}/recalculate`, finance, {}))
        .statusCode,
    ).toBe(409);
  });

  it('allocates a two-benefit policy by underwriting entity so the entities add up to the premium', async () => {
    const p = await bindPolicy({ selection: ['trip_interruption'] });
    const [r] = await recordsOf(p.id);
    expect(r).toMatchObject({ status: 'ready', premium: '126.00', tax: '2.94' });
    expect(r!.allocation.map((l) => [l.entity, l.premium, l.tax])).toEqual([
      ['VSC', '84.00', '1.68'],
      ['ABIC', '42.00', '1.26'],
    ]);
    expect(sum(r!.allocation.map((l) => l.premium))).toBe(126);
    expect(sum(r!.perBenefit.map((b) => b.premium))).toBe(126);
    expect(sum(r!.perTraveller.map((b) => b.premium))).toBe(126);
    expect(r!.commission?.amount).toBe('12.60');
  });

  it('records a change as its difference and a cancellation as a refund with the commission clawed back', async () => {
    const p = await bindPolicy();
    const up = {
      type: 'change_cost',
      reason: 'More cost',
      costs: [{ travellerId: 'T1', costPerTraveller: '5000' }],
    };
    expect(
      (
        await send(
          t,
          'POST',
          `/v1/policies/${p.id}/servicing`,
          st.tokens.admin,
          { request: up, confirmAmount: '16.00' },
          { 'idempotency-key': `bill-up-${Date.now()}` },
        )
      ).statusCode,
    ).toBe(200);
    const cancel = { type: 'cancel', reason: 'Changed my mind', noLoss: true };
    expect(
      (
        await send(
          t,
          'POST',
          `/v1/policies/${p.id}/servicing`,
          st.tokens.admin,
          { request: cancel, confirmAmount: '100.00' },
          { 'idempotency-key': `bill-cx-${Date.now()}` },
        )
      ).statusCode,
    ).toBe(200);
    const rs = await recordsOf(p.id);
    expect(rs.map((r) => [r.type, r.premium])).toEqual([
      ['bind', '84.00'],
      ['change', '16.00'],
      ['cancellation', '-100.00'],
    ]);
    expect(rs[1]).toMatchObject({ charge: '16.00', tax: '0.32', commission: { amount: '1.60' } });
    expect(rs[1]!.perBenefit.find((b) => b.code === 'trip_cancellation')!.premium).toBe('16.00');
    expect(rs[1]!.worksheetIds).toHaveLength(1);
    // The refund takes back commission at the rate the bind earned, and the tax with it.
    expect(rs[2]).toMatchObject({
      type: 'cancellation',
      refund: '100.00',
      charge: '0.00',
      tax: '-2.00',
      commission: { amount: '-10.00', ratePercent: '10.0000' },
      status: 'ready',
    });
    expect(rs[2]!.worksheetIds).toEqual(rs[0]!.worksheetIds);
    // The whole life of the policy nets to nothing.
    expect(sum(rs.map((r) => r.premium))).toBe(0);
    expect(sum(rs.map((r) => r.commission!.amount))).toBe(0);
  });

  it('keeps what a premium that the plan retains (no refund after the review period) as retained, with no money moved', async () => {
    const p = await bindPolicy();
    t.setNow(
      new Date(`${new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`),
    );
    try {
      const cancel = { type: 'cancel', reason: 'Changed my mind late', noLoss: true };
      expect(
        (
          await send(
            t,
            'POST',
            `/v1/policies/${p.id}/servicing`,
            st.tokens.admin,
            { request: cancel, confirmAmount: '0.00' },
            { 'idempotency-key': `bill-late-${Date.now()}` },
          )
        ).statusCode,
      ).toBe(200);
    } finally {
      t.setNow(null);
    }
    const rs = await recordsOf(p.id);
    expect(rs[1]).toMatchObject({
      type: 'cancellation',
      premium: '0.00',
      refund: '0.00',
      retained: '84.00',
      commission: { amount: '0.00' },
    });
  });

  it('is immutable history, and a record cannot be recalculated or deleted after it leaves "held"', async () => {
    const [r] = await recordsOf(heldPolicy.id);
    await expect(
      asPlatform((q) =>
        q(`UPDATE billing.premium_records SET premium_cents = 1, charge_cents = 1 WHERE id = $1`, [
          r!.id,
        ]),
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      asPlatform((q) =>
        q(`UPDATE billing.premium_records SET tax_cents = 1 WHERE id = $1`, [r!.id]),
      ),
    ).rejects.toThrow(/not held cannot be recalculated/);
    await expect(
      asPlatform((q) => q(`DELETE FROM billing.premium_records WHERE id = $1`, [r!.id])),
    ).rejects.toThrow(/permission denied|cannot be deleted/);
    // Another account's finance view sees nothing of it.
    expect(
      (await send(t, 'GET', `/v1/premium-records/${r!.id}`, st.tokens.partnerB)).statusCode,
    ).toBe(404);
    expect(
      (await send(t, 'GET', `/v1/premium-records/${r!.id}`, st.tokens.partner)).statusCode,
    ).toBe(200);
  });
});

describe('batches with control totals, sending and confirmation (E08-F03, E08-F04-S01)', () => {
  let batchId: string;
  let batchTotals: {
    count: number;
    premium: string;
    charges: string;
    refunds: string;
    commission: string;
    tax: string;
  };

  it('takes each ready record once into a batch whose file carries the same totals in its header and trailer', async () => {
    const readyBefore = (
      await send(t, 'GET', '/v1/premium-records?status=ready&limit=200', finance)
    ).json().items.length;
    expect(readyBefore).toBeGreaterThan(5);
    const res = await send(t, 'POST', '/v1/billing/batches', finance, {});
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    batchId = b.id;
    batchTotals = b.totals;
    expect(b).toMatchObject({ status: 'ready', totals: { count: readyBefore } });
    // The control totals are the sum of what the batch holds.
    const items = (
      await send(t, 'GET', `/v1/premium-records?batchId=${b.id}&limit=200`, finance)
    ).json().items as Rec[];
    expect(items).toHaveLength(readyBefore);
    expect(items.every((r) => r.status === 'batched')).toBe(true);
    expect(sum(items.map((r) => r.premium))).toBe(Number(b.totals.premium));
    expect(sum(items.map((r) => r.commission!.amount))).toBe(Number(b.totals.commission));
    expect(sum(items.map((r) => r.tax!))).toBe(Number(b.totals.tax));
    // The file: header, one line per record, trailer; its hash is the one recorded.
    const file = await send(t, 'GET', `/v1/billing/batches/${b.id}/file`, finance);
    expect(file.statusCode).toBe(200);
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(b.sha256);
    const lines = file.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; totals?: unknown; id?: string });
    expect(lines[0]).toMatchObject({ type: 'header', batchId: b.id, totals: b.totals });
    expect(lines.at(-1)).toMatchObject({ type: 'trailer', totals: b.totals });
    expect(
      lines
        .filter((l) => l.type === 'record')
        .map((l) => l.id)
        .sort(),
    ).toEqual(items.map((r) => r.id).sort());
    // Nothing is sent twice: the records are spoken for, so a second batch has nothing to take, and the database refuses to move one.
    expect((await send(t, 'POST', '/v1/billing/batches', finance, {})).json()).toMatchObject({
      batch: null,
    });
    await expect(
      asPlatform((q) =>
        q(`UPDATE billing.premium_records SET batch_id = NULL WHERE batch_id = $1`, [b.id]),
      ),
    ).rejects.toThrow(/one batch for good/);
    // Permissions: the billing system cannot collect batches; finance cannot confirm them.
    expect((await send(t, 'POST', '/v1/billing/batches', billing, {})).statusCode).toBe(403);
  });

  it('waits when no channel is configured, then sends over a file drop with a control file', async () => {
    const none = await sendNext(t.pool, t.files, null, logger);
    expect(none).toBe(false);
    expect((await send(t, 'GET', `/v1/billing/batches/${batchId}`, finance)).json()).toMatchObject({
      status: 'ready',
      lastError: expect.stringContaining('No billing channel'),
    });
    expect(await sendNext(t.pool, t.files, new FileDropChannel(outDir), logger)).toBe(true);
    const b = (await send(t, 'GET', `/v1/billing/batches/${batchId}`, finance)).json();
    expect(b).toMatchObject({ status: 'sent', channel: 'file', attempts: 1, lastError: null });
    const name = `astra-batch-${String(b.number).padStart(8, '0')}`;
    expect(existsSync(join(outDir, `${name}.ndjson`))).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir, `${name}.control.json`), 'utf8'))).toMatchObject({
      batchId,
      sha256: b.sha256,
      totals: batchTotals,
    });
    const items = (
      await send(t, 'GET', `/v1/premium-records?batchId=${batchId}&limit=200`, finance)
    ).json().items as Rec[];
    expect(items.every((r) => r.status === 'sent')).toBe(true);
  });

  it('is confirmed record by record when billing’s totals agree, and the status shows on the policy', async () => {
    const items = (
      await send(t, 'GET', `/v1/premium-records?batchId=${batchId}&limit=200`, finance)
    ).json().items as { id: string; policyId: string }[];
    const body = {
      batchId,
      received: {
        count: batchTotals.count,
        premium: batchTotals.premium,
        commission: batchTotals.commission,
        tax: batchTotals.tax,
      },
      records: items.map((r, i) => ({
        recordId: r.id,
        status: 'accepted',
        reference: `BILL-${i}`,
      })),
    };
    expect((await send(t, 'POST', '/v1/billing/confirmations', finance, body)).statusCode).toBe(
      403,
    );
    const res = await send(t, 'POST', '/v1/billing/confirmations', billing, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'confirmed', accepted: items.length, rejected: 0 });
    expect((await send(t, 'GET', `/v1/billing/batches/${batchId}`, finance)).json()).toMatchObject({
      status: 'confirmed',
    });
    const rs = await recordsOf(items.find((r) => r.policyId)!.policyId);
    expect(
      rs.every((r) => r.status === 'confirmed' && r.billingReference?.startsWith('BILL-')),
    ).toBe(true);
    // Repeating the confirmation answers the same.
    expect(
      (await send(t, 'POST', '/v1/billing/confirmations', billing, body)).json(),
    ).toMatchObject({ status: 'confirmed' });
  });

  it('marks a batch a mismatch, and raises an alert, when billing’s totals differ; resending and confirming then settles it', async () => {
    const p = await bindPolicy();
    const batch = (await send(t, 'POST', '/v1/billing/batches', finance, {})).json();
    expect(batch.totals.count).toBe(1);
    await sendNext(t.pool, t.files, new FileDropChannel(outDir), logger);
    const [rec] = await recordsOf(p.id);
    const answer = (premium: string) => ({
      batchId: batch.id,
      received: { count: 1, premium, commission: batch.totals.commission, tax: batch.totals.tax },
      records: [{ recordId: rec!.id, status: 'accepted', reference: 'BILL-OK' }],
    });
    const bad = await send(t, 'POST', '/v1/billing/confirmations', billing, answer('83.00'));
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json()).toMatchObject({
      status: 'mismatch',
      differences: ['premium: sent 84.00, received 83.00'],
    });
    expect((await recordsOf(p.id))[0]).toMatchObject({ status: 'sent' });
    const alerts = await asPlatform((q) =>
      q(
        `SELECT count(*)::int AS n FROM platform.outbox WHERE type = 'BillingBatchFailed' AND data->>'batchId' = $1 AND data->>'status' = 'mismatch'`,
        [batch.id],
      ),
    );
    expect(alerts.rows[0]!.n).toBe(1);
    // Confirming again without sending is refused; sending again and confirming settles it.
    expect(
      (await send(t, 'POST', '/v1/billing/confirmations', billing, answer('84.00'))).statusCode,
    ).toBe(409);
    expect(
      (await send(t, 'POST', `/v1/billing/batches/${batch.id}/retry`, finance, {})).statusCode,
    ).toBe(200);
    await sendNext(t.pool, t.files, new FileDropChannel(outDir), logger);
    expect(
      (await send(t, 'POST', '/v1/billing/confirmations', billing, answer('84.00'))).json(),
    ).toMatchObject({ status: 'confirmed' });
  });

  it('requires every record answered, and records a rejection with its reason', async () => {
    const a = await bindPolicy();
    const b = await bindPolicy();
    const batch = (await send(t, 'POST', '/v1/billing/batches', finance, {})).json();
    expect(batch.totals.count).toBe(2);
    await sendNext(t.pool, t.files, new FileDropChannel(outDir), logger);
    const [ra] = await recordsOf(a.id);
    const [rb] = await recordsOf(b.id);
    const received = {
      count: 2,
      premium: batch.totals.premium,
      commission: batch.totals.commission,
      tax: batch.totals.tax,
    };
    expect(
      (
        await send(t, 'POST', '/v1/billing/confirmations', billing, {
          batchId: batch.id,
          received,
          records: [{ recordId: ra!.id, status: 'accepted' }],
        })
      ).statusCode,
    ).toBe(400);
    const res = await send(t, 'POST', '/v1/billing/confirmations', billing, {
      batchId: batch.id,
      received,
      records: [
        { recordId: ra!.id, status: 'accepted', reference: 'OK-1' },
        { recordId: rb!.id, status: 'rejected', reason: 'Unknown account code' },
      ],
    });
    expect(res.json()).toMatchObject({ status: 'rejected', accepted: 1, rejected: 1 });
    expect((await recordsOf(b.id))[0]).toMatchObject({
      status: 'rejected',
      billingReason: 'Unknown account code',
    });
    expect((await recordsOf(a.id))[0]).toMatchObject({
      status: 'confirmed',
      billingReference: 'OK-1',
    });
  });

  it('sends again with the same batch ID when billing does not confirm, then raises an alert and marks it unconfirmed', async () => {
    await bindPolicy();
    const batch = (await send(t, 'POST', '/v1/billing/batches', finance, {})).json();
    const sent: { id: string; signature: string; sha: string; totals: string }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      sent.push({
        id: h['x-astra-batch-id']!,
        signature: h['x-astra-signature']!,
        sha: h['x-astra-sha256']!,
        totals: h['x-astra-control-totals']!,
      });
      return new Response('ok', { status: 202 });
    }) as unknown as typeof fetch;
    const channel: BillingChannel = new HttpChannel(
      'https://billing.example.test/batches',
      'a-test-signing-secret-1234',
      fakeFetch,
    );
    const o: SendOptions = { confirmTimeoutMs: 1, maxAttempts: 2, retryDelaysMs: [1] };
    expect(await sendNext(t.pool, t.files, channel, logger, o)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await sendNext(t.pool, t.files, channel, logger, o)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.id).toBe(batch.id);
    expect(sent[1]!.id).toBe(batch.id);
    // The signature covers the batch ID and the file's hash.
    const { createHmac } = await import('node:crypto');
    expect(sent[0]!.signature).toBe(
      createHmac('sha256', 'a-test-signing-secret-1234')
        .update(`${batch.id}.${batch.sha256}`)
        .digest('hex'),
    );
    expect(JSON.parse(sent[0]!.totals)).toEqual(batch.totals);
    await new Promise((r) => setTimeout(r, 20));
    expect(await sendNext(t.pool, t.files, channel, logger, o)).toBe(true);
    expect(sent).toHaveLength(2);
    expect((await send(t, 'GET', `/v1/billing/batches/${batch.id}`, finance)).json()).toMatchObject(
      { status: 'unconfirmed', attempts: 2 },
    );
    const alerts = await asPlatform((q) =>
      q(
        `SELECT count(*)::int AS n FROM platform.outbox WHERE type = 'BillingBatchFailed' AND data->>'batchId' = $1 AND data->>'status' = 'unconfirmed'`,
        [batch.id],
      ),
    );
    expect(alerts.rows[0]!.n).toBe(1);
    expect(
      (await send(t, 'POST', `/v1/billing/batches/${batch.id}/retry`, finance, {})).json(),
    ).toMatchObject({ status: 'ready', attempts: 0 });
  });

  it('retries a failing send with back-off and reports the reason', async () => {
    const down: BillingChannel = {
      kind: 'http',
      send: async () => {
        throw new Error('The billing system answered HTTP 503');
      },
    };
    const o: SendOptions = { confirmTimeoutMs: 60_000, maxAttempts: 3, retryDelaysMs: [60_000] };
    expect(await sendNext(t.pool, t.files, down, logger, o)).toBe(true);
    const list = (await send(t, 'GET', '/v1/billing/batches?status=ready', finance)).json()
      .items as { attempts: number; lastError: string | null; nextAttemptAt: string | null }[];
    expect(list[0]).toMatchObject({
      attempts: 1,
      lastError: 'The billing system answered HTTP 503',
    });
    expect(list[0]!.nextAttemptAt).not.toBeNull();
  });
});

describe('export at volume (E08-F04-S01)', () => {
  it('writes a large batch as a stream, with matching totals, at a measured rate', async () => {
    const rows = 20_000;
    // Synthetic ready records on an existing policy, inserted set-based.
    await asPlatform((q) =>
      q(
        `INSERT INTO billing.premium_records (number, type, account_id, policy_id, policy_event_seq, status, premium_cents, charge_cents, refund_cents, retained_cents, commission_cents, tax_cents, basis, inputs, occurred_at)
         SELECT 'VOL-' || lpad(g::text, 8, '0'), 'change', p.account_id, p.id, 1000000 + g, 'ready', 1050, 1050, 0, 0, 105, 21, '{}', '{}', now()
           FROM generate_series(1, $2::int) g CROSS JOIN policies.policies p WHERE p.id = $1`,
        [heldPolicy.id, rows],
      ),
    );
    const available = Number(
      (
        await asPlatform((q) =>
          q(`SELECT count(*)::int AS n FROM billing.premium_records WHERE number LIKE 'VOL-%'`),
        )
      ).rows[0]!.n,
    );
    expect(available).toBe(rows);
    const started = Date.now();
    const res = await send(t, 'POST', '/v1/billing/batches', finance, { limit: 200_000 });
    const ms = Date.now() - started;
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().totals.count).toBeGreaterThanOrEqual(rows);
    expect(res.json().totals).toMatchObject({
      premium: expect.any(String),
      commission: expect.any(String),
      tax: expect.any(String),
    });
    const perSecond = Math.round((res.json().totals.count / ms) * 1000);
    console.warn(
      `Batch of ${res.json().totals.count} records built and written in ${ms} ms (${perSecond} records/s)`,
    );
    expect(perSecond).toBeGreaterThan(500);
    const file = await send(t, 'GET', `/v1/billing/batches/${res.json().id}/file`, finance);
    const lines = file.body.trim().split('\n');
    expect(lines.length).toBe(res.json().totals.count + 2);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'trailer', totals: res.json().totals });
  }, 240_000);
});

describe('card programme premium (E08-F04-S02)', () => {
  it('counts the accounts eligible at month end and applies the approved rate, once per programme and month', async () => {
    const manager = await t.idp.token({
      roles: ['card_programme_manager'],
      sub: 'cpm-1',
      name: 'Carla Programme',
    });
    const issuer = await insertAccount(
      t.pool,
      `PGM-${Date.now().toString(36).toUpperCase()}`,
      'card_issuer',
    );
    const issuerToken = await t.idp.token({
      roles: ['partner_developer'],
      accountId: issuer,
      sub: 'svc-pgm',
    });
    const mp = await send(t, 'POST', '/v1/master-policies', manager, {
      accountId: issuer,
      policyNumber: `MP-PGM-${Date.now()}`,
      underwriter: 'ABIC',
      states: ['DE'],
      effectiveFrom: '2026-01-01',
    });
    const code = `PGM-${Date.now().toString(36).toUpperCase()}`;
    const prog = await send(t, 'POST', '/v1/card-programmes', manager, {
      masterPolicyId: mp.json().id,
      code,
      name: 'Synthetic programme',
      cardProduct: 'Gold',
      states: ['DE'],
      effectiveFrom: '2026-01-01',
      paymentCondition: { rule: 'none' },
      eligibilityRule: 'purchase_date',
      maxRejectPercent: 10,
    });
    expect(prog.statusCode, prog.body).toBe(201);
    const pid = prog.json().id as string;
    const processor = new FeedProcessor(t.pool, t.files, logger);
    const feed = (seq: number, kind: string, details: string[]) =>
      [
        `H|ASTRA-ELIG|1|${code}|${seq}|${kind}|2026-03-01`,
        ...details,
        `T|${details.length}|${details.length}|0|0`,
        '',
      ].join('\n');
    const upload = (mode: string, body: string) =>
      t.app.inject({
        method: 'POST',
        url: `/v1/card-programmes/${pid}/feeds?mode=${mode}&fileName=feed.txt`,
        headers: {
          authorization: `Bearer ${issuerToken}`,
          'content-type': 'application/octet-stream',
        },
        payload: Buffer.from(body),
      });
    const drain = async () => {
      for (let i = 0; i < 10; i++) {
        const id = await processor.claimNext();
        if (!id) return;
        await processor.process(id);
      }
    };
    expect(
      (await upload('test', feed(1, 'FULL', ['D|tok_test|GOLD|A|2025-01-01|']))).statusCode,
    ).toBe(202);
    await drain();
    expect(
      (
        await send(t, 'POST', `/v1/card-programmes/${pid}/go-live`, manager, {
          reason: 'Test feed passed.',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await upload(
          'live',
          feed(1, 'FULL', [
            'D|tok_a|GOLD|A|2026-01-01|',
            'D|tok_b|GOLD|A|2026-02-01|',
            'D|tok_c|GOLD|A|2026-03-01|',
          ]),
        )
      ).statusCode,
    ).toBe(202);
    await drain();

    // Without an approved rate nothing is invented.
    expect(
      (
        await send(t, 'POST', '/v1/programme-premium', finance, {
          programmeId: pid,
          month: '2026-03',
        })
      ).statusCode,
    ).toBe(412);
    const rule = await send(t, 'POST', '/v1/programme-premium-rules', finance, {
      programmeId: pid,
      effectiveFrom: '2026-01-01',
      rate: '1.5000',
    });
    expect(rule.statusCode, rule.body).toBe(201);
    expect(
      (await send(t, 'POST', `/v1/programme-premium-rules/${rule.json().id}/approve`, finance, {}))
        .statusCode,
    ).toBe(403);
    const approver = await t.idp.token({ roles: ['compliance_officer'], sub: 'comp-3' });
    expect(
      (await send(t, 'POST', `/v1/programme-premium-rules/${rule.json().id}/approve`, approver, {}))
        .statusCode,
    ).toBe(200);

    const rec = await send(t, 'POST', '/v1/programme-premium', finance, {
      programmeId: pid,
      month: '2026-03',
    });
    expect(rec.statusCode, rec.body).toBe(201);
    // Three accounts were eligible on 31 March: 3 x 1.50.
    expect(rec.json()).toMatchObject({
      type: 'programme',
      status: 'ready',
      period: '2026-03',
      premium: '4.50',
      basis: { basis: 'per_account_per_month', accounts: 3, rate: '1.5000' },
    });
    expect(rec.json().allocation[0]).toMatchObject({ entity: 'ABIC', premium: '4.50' });
    expect(
      (
        await send(t, 'POST', '/v1/programme-premium', finance, {
          programmeId: pid,
          month: '2026-03',
        })
      ).statusCode,
    ).toBe(409);
    // It goes to billing in the same batches as retail premium.
    const b = await send(t, 'POST', '/v1/billing/batches', finance, {});
    expect(b.statusCode, b.body).toBe(201);
    expect(
      (await send(t, 'GET', `/v1/premium-records?batchId=${b.json().id}`, finance))
        .json()
        .items.map((r: { type: string }) => r.type),
    ).toContain('programme');
    expect(today()).toBeTruthy();
  }, 120_000);
});
