/**
 * Increment 5a: rate manual library, parity gate and rating through the API (E02-F01-S01, E02-F07-S01/S02,
 * E02-F09). The manual is the test fixture holding only the values the specification quotes; it is not
 * the filed manual. The "workbook" case below is synthetic, computed from those quoted values.
 */
import Decimal from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SPEC_ILLUSTRATIVE_REQUEST, SPEC_QUOTED_DE_TCAN } from '@astra/rating/fixtures';
import { bearer, createTestApp, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
let loader: string;
let checker: string;
let compliance: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await resetDatabase();
  loader = await t.idp.token({
    roles: ['rating_analyst'],
    sub: 'analyst-loader',
    name: 'Lee Loader',
  });
  checker = await t.idp.token({
    roles: ['rating_analyst'],
    sub: 'analyst-checker',
    name: 'Chris Checker',
  });
  compliance = await t.idp.token({ roles: ['compliance_officer'], sub: 'compliance-1' });
});

let n = 0;
const send = (
  method: 'POST' | 'GET',
  url: string,
  token: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url,
    headers: { ...bearer(token), 'idempotency-key': `rate-${Date.now()}-${n++}`, ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const DOC = { ...SPEC_QUOTED_DE_TCAN, perilPackage: null };
const EXPECTED = new Decimal('1.475')
  .mul(42)
  .mul(
    ['0.72', '1.288', '0.768', '1', '1.6286', '1.3333', '1.28'].reduce(
      (a, f) => a.mul(f),
      new Decimal(1),
    ),
  )
  .toFixed(2, Decimal.ROUND_HALF_UP);

async function loadManual(over: Record<string, unknown> = {}) {
  const res = await send('POST', '/v1/rate-manuals', loader, {
    code: 'RETR-SP-VU-DE-0426',
    state: 'DE',
    benefit: 'TCAN',
    effectiveFrom: '2026-01-01',
    source: 'Test fixture: values quoted in the specification (not the filed manual)',
    document: DOC,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number; status: string };
}

async function fileManualInDelaware() {
  const states = await send('POST', '/v1/reference-data/us_states/versions', loader, {
    effectiveFrom: '2026-01-01',
    source: 'Test fixture (synthetic)',
    entries: [{ code: 'DE', name: 'Delaware', kind: 'state' }],
  });
  await send(
    'POST',
    `/v1/reference-data/us_states/versions/${states.json().id}/decision`,
    compliance,
    { decision: 'approve', reason: 'Test fixture.' },
  );
  const f = (
    await send('POST', '/v1/filings', compliance, {
      states: ['DE'],
      insurer: 'VSC',
      itemType: 'rate_manual',
      itemReference: 'RETR-SP-VU-DE-0426',
    })
  ).json().items[0];
  await send('POST', `/v1/filings/${f.id}/status`, compliance, {
    status: 'submitted',
    on: '2025-10-01',
    reason: 'Filed.',
  });
  const ok = await send('POST', `/v1/filings/${f.id}/status`, compliance, {
    status: 'approved',
    on: '2025-12-01',
    effectiveFrom: '2026-01-01',
    reason: 'Approved.',
  });
  expect(ok.statusCode, ok.body).toBe(200);
}

const CSV = [
  'name,expected_amount,age,pre_existing_waived,cost_per_traveller,purchase_date,departure_date,return_date,destination_region,business_segment,package_type,penalty_days,factor:table.2.1.4',
  `Spec illustrative lookup,${EXPECTED},45,true,4200,2026-11-21,2026-12-11,2026-12-20,Europe,OTA - Cruise,optional,60,0.7200`,
].join('\n');

describe('rate manuals and rating (E02)', () => {
  it('rates only with published manuals, which need approval, a filing in effect and full parity', async () => {
    const m = await loadManual();
    expect(m).toMatchObject({ version: 1, status: 'draft' });

    // A preview of the draft shows the worksheet, labelled as a preview and as a loss cost.
    const preview = await send('POST', '/v1/rating/rate', loader, {
      manualId: m.id,
      request: SPEC_ILLUSTRATIVE_REQUEST,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ amount: EXPECTED, kind: 'loss_cost', preview: true });
    // Without a published manual, the benefit cannot be rated.
    const none = await send('POST', '/v1/rating/rate', loader, {
      request: SPEC_ILLUSTRATIVE_REQUEST,
    });
    expect(none.statusCode).toBe(412);
    expect(none.json().detail).toContain('No published TCAN manual is in effect in DE');

    // Maker-checker.
    expect(
      (await send('POST', `/v1/rate-manuals/${m.id}/approve`, loader, { note: 'My own load.' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await send('POST', `/v1/rate-manuals/${m.id}/approve`, checker, {
          note: 'Tables checked against the pages.',
        })
      ).statusCode,
    ).toBe(200);

    let ready = (await send('GET', `/v1/rate-manuals/${m.id}/readiness`, loader)).json();
    expect(ready.ready).toBe(false);
    expect(ready.checks.find((c: { check: string }) => c.check === 'filed').detail).toBe(
      'No filing is recorded for DE.',
    );
    expect(ready.checks.find((c: { check: string }) => c.check === 'parity').detail).toContain(
      'No parity cases',
    );
    expect((await send('POST', `/v1/rate-manuals/${m.id}/publish`, checker)).statusCode).toBe(412);

    // Parity: the prototype rater is never a source; workbook cases are imported and run.
    const proto = await send(
      'POST',
      `/v1/rate-manuals/${m.id}/parity-cases?source=Prototype%20rater&rateDate=2026-11-01`,
      loader,
      CSV,
      { 'content-type': 'text/csv' },
    );
    expect(proto.statusCode).toBe(400);
    const imp = await send(
      'POST',
      `/v1/rate-manuals/${m.id}/parity-cases?source=Synthetic%20workbook%20from%20quoted%20values&rateDate=2026-11-01`,
      loader,
      CSV,
      { 'content-type': 'text/csv' },
    );
    expect(imp.statusCode, imp.body).toBe(201);
    const run = await send('POST', `/v1/rate-manuals/${m.id}/parity-runs`, loader);
    expect(run.json()).toMatchObject({ total: 1, passed: 1 });

    await fileManualInDelaware();
    ready = (await send('GET', `/v1/rate-manuals/${m.id}/readiness`, loader)).json();
    expect(ready).toMatchObject({ ready: true });
    const pub = await send('POST', `/v1/rate-manuals/${m.id}/publish`, checker);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().status).toBe('published');

    // Published: rated by state, benefit and date, with a stored worksheet that reproduces exactly.
    const rated = await send('POST', '/v1/rating/rate', loader, {
      request: SPEC_ILLUSTRATIVE_REQUEST,
      store: true,
    });
    expect(rated.json()).toMatchObject({
      amount: EXPECTED,
      preview: false,
      manual: { version: 1 },
    });
    const again = await send(
      'POST',
      `/v1/rating/worksheets/${rated.json().worksheetId}/reproduce`,
      loader,
    );
    expect(again.json().identical).toBe(true);
    const before = await send('POST', '/v1/rating/rate', loader, {
      request: { ...SPEC_ILLUSTRATIVE_REQUEST, rateDate: '2025-12-31' },
    });
    expect(before.statusCode).toBe(412);

    // Published manuals never change.
    const client = await t.pool.connect();
    try {
      await expect(
        client.query(`UPDATE rating.manuals SET document = '{}' WHERE id = $1`, [m.id]),
      ).rejects.toThrow(/content cannot change/);
    } finally {
      client.release();
    }
  });

  it('makes a parity run stale when the cases change, and fails cases that do not match', async () => {
    const m = await loadManual();
    await send(
      'POST',
      `/v1/rate-manuals/${m.id}/parity-cases?source=Synthetic%20workbook&rateDate=2026-11-01`,
      loader,
      CSV,
      { 'content-type': 'text/csv' },
    );
    await send('POST', `/v1/rate-manuals/${m.id}/parity-runs`, loader);
    const wrong = CSV.replace(EXPECTED, '99.99');
    await send(
      'POST',
      `/v1/rate-manuals/${m.id}/parity-cases?source=Synthetic%20workbook&rateDate=2026-11-01`,
      loader,
      wrong,
      { 'content-type': 'text/csv' },
    );
    const ready = (await send('GET', `/v1/rate-manuals/${m.id}/readiness`, loader)).json();
    expect(ready.checks.find((c: { check: string }) => c.check === 'parity').detail).toContain(
      'changed since the last run',
    );
    const run = (await send('POST', `/v1/rate-manuals/${m.id}/parity-runs`, loader)).json();
    expect(run).toMatchObject({ total: 1, passed: 0 });
    expect(run.results[0]).toMatchObject({ expectedAmount: '99.99', actualAmount: EXPECTED });
  });

  it('refuses illustrative manuals outside demonstration and sandbox, and checks table references', async () => {
    const illus = await send('POST', '/v1/rate-manuals', loader, {
      code: 'ILLUS-DE-TI',
      state: 'DE',
      benefit: 'TINT',
      effectiveFrom: '2026-01-01',
      illustrative: true,
      source: 'Estimated loading',
      document: DOC,
    });
    expect(illus.statusCode).toBe(403);
    const broken = await send('POST', '/v1/rate-manuals', loader, {
      code: 'RETR-SP-VU-DE-0426',
      state: 'DE',
      benefit: 'TCAN',
      effectiveFrom: '2026-01-01',
      source: 'Test',
      document: { ...DOC, variables: [{ label: 'Missing', tables: ['9.9.9'] }] },
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().detail).toContain('table 9.9.9');
  });
});
