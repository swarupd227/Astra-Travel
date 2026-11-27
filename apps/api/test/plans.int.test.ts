/**
 * Increment 6: plan builder and publishing (E01-F03, E01-F04, E10-F01-S02) through the API and database.
 * The schedule is synthetic (names follow the specification, bracketed ranges are invented for the test);
 * the rate manual is the test fixture holding only the values the specification quotes.
 */
import Decimal from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SPEC_ILLUSTRATIVE_REQUEST, SPEC_QUOTED_DE_TCAN } from '@astra/rating/fixtures';
import { bearer, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
let product: string;
let builder2: string;
let compliance: string;
let analyst: string;
let analyst2: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await resetDatabase();
  product = await t.idp.token({ roles: ['product_manager'], sub: 'product-1' });
  builder2 = await t.idp.token({ roles: ['product_manager'], sub: 'product-2' });
  compliance = await t.idp.token({ roles: ['compliance_officer'], sub: 'compliance-1' });
  analyst = await t.idp.token({ roles: ['rating_analyst'], sub: 'analyst-1' });
  analyst2 = await t.idp.token({ roles: ['rating_analyst'], sub: 'analyst-2' });
});

let n = 0;
const send = (
  method: 'POST' | 'PUT' | 'DELETE' | 'GET',
  url: string,
  token: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url,
    headers: { ...bearer(token), 'idempotency-key': `plan-${Date.now()}-${n++}`, ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const SCHEDULE = [
  'SCHEDULE OF BENEFITS (synthetic test schedule)',
  'Trip Cancellation maximum [$500-$10,000] [PER PERSON] [PER TRIP]',
  'You may cancel within the [ten (10) - fifteen (15)] day review period.',
].join('\n');

/** Schedule edition with an approved map, and an approved catalogue built from it. */
async function approvedCatalogue(): Promise<{ edition: string; catalogue: string }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/form-editions?formNumber=test_sch&edition=2026-04&title=Synthetic%20schedule&kind=schedule&insurer=VSC&fileName=s.txt',
    headers: { ...bearer(compliance), 'content-type': 'text/plain' },
    payload: Buffer.from(SCHEDULE),
  });
  expect(res.statusCode, res.body).toBe(201);
  const edition = res.json().id as string;
  const map = (await send('POST', `/v1/form-editions/${edition}/maps`, product)).json()
    .id as string;
  const spans = (await send('GET', `/v1/form-editions/${edition}/brackets`, product)).json()
    .items as {
    start: number;
    end: number;
    text: string;
    suggestion: { type: string; constraints: Record<string, unknown> } | null;
  }[];
  const keys: Record<string, [string, string]> = {
    '[$500-$10,000]': ['tc_max', 'Trip Cancellation maximum'],
    '[PER PERSON] [PER TRIP]': ['tc_basis', 'Trip Cancellation basis'],
    '[ten (10) - fifteen (15)]': ['review', 'Review period'],
  };
  for (const s of spans) {
    const k = keys[s.text];
    if (!k) continue;
    const r = await send('PUT', `/v1/variable-maps/${map}/variables/${k[0]}`, product, {
      key: k[0],
      label: k[1],
      type: s.suggestion!.type,
      constraints: s.suggestion!.constraints,
      textStart: s.start,
      textEnd: s.end,
      excerpt: s.text,
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  expect(
    (
      await send('POST', `/v1/variable-maps/${map}/approve`, compliance, {
        note: 'Checked against the test schedule.',
      })
    ).statusCode,
  ).toBe(200);
  const cat = (await send('POST', `/v1/form-editions/${edition}/catalogues`, product, {})).json()
    .id as string;
  const sv = (key: string) => ({ source: 'schedule', key });
  expect(
    (
      await send('PUT', `/v1/benefit-catalogues/${cat}/benefits/trip_cancellation`, product, {
        code: 'trip_cancellation',
        name: 'Trip Cancellation',
        group: 'pre_departure',
        maximum: { variable: sv('tc_max'), basis: { kind: 'variable', variable: sv('tc_basis') } },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await send('PUT', `/v1/benefit-catalogues/${cat}/covered-reasons/sickness`, product, {
        code: 'sickness',
        text: 'Sickness, injury or death (synthetic wording)',
        category: 'Medical and Health',
        appliesTo: ['trip_cancellation', 'trip_interruption'],
        coverageLevels: ['self', 'family_member'],
        perilNumber: '1',
      })
    ).statusCode,
  ).toBe(200);
  const ok = await send('POST', `/v1/benefit-catalogues/${cat}/approve`, compliance, {
    note: 'Matches the test schedule.',
  });
  expect(ok.statusCode, ok.body).toBe(200);
  return { edition, catalogue: cat };
}

const BASE_DOC = {
  benefits: [
    { code: 'trip_cancellation', packaging: 'standalone_optional', ratingBenefit: 'TCAN' },
  ],
  coveredReasons: [{ code: 'sickness', levels: ['self'] }],
  values: { 'schedule:tc_max': 5000, 'schedule:tc_basis': 'PER PERSON' },
  settings: [
    { setting: 'review_period', variable: { source: 'schedule', key: 'review' }, value: 10 },
  ],
  bounds: { 'schedule:tc_max': { min: 1000, max: 8000 } },
};

async function approvedBasePlan(catalogue: string): Promise<string> {
  const base = await send('POST', '/v1/plans', product, {
    kind: 'base',
    code: 'BASE-TC',
    name: 'Trip Cancellation base plan (synthetic)',
    term: 'single_trip',
    catalogueId: catalogue,
    effectiveFrom: '2026-01-01',
  });
  expect(base.statusCode, base.body).toBe(201);
  const draft = base.json().draft.id as string;
  const saved = await send('PUT', `/v1/plan-versions/${draft}`, product, { document: BASE_DOC });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().problems).toEqual([]);
  expect(
    (
      await send('POST', `/v1/plan-versions/${draft}/approve`, compliance, {
        note: 'Base plan checked.',
      })
    ).statusCode,
  ).toBe(200);
  return base.json().plan.id as string;
}

/** The fixture TCAN manual published in Delaware: approved by a second analyst, filed, parity passing. */
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

async function fileInDelaware(item: Record<string, unknown>) {
  const f = (
    await send('POST', '/v1/filings', compliance, { states: ['DE'], insurer: 'VSC', ...item })
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

async function delawareInReferenceData() {
  const states = await send('POST', '/v1/reference-data/us_states/versions', analyst, {
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
}

async function publishedManual() {
  const m = await send('POST', '/v1/rate-manuals', analyst, {
    code: 'RETR-SP-VU-DE-0426',
    state: 'DE',
    benefit: 'TCAN',
    effectiveFrom: '2026-01-01',
    source: 'Test fixture: values quoted in the specification (not the filed manual)',
    document: DOC,
  });
  const id = m.json().id as string;
  await send('POST', `/v1/rate-manuals/${id}/approve`, analyst2, {
    note: 'Tables checked against the pages.',
  });
  const csv = [
    'name,expected_amount,age,pre_existing_waived,cost_per_traveller,purchase_date,departure_date,return_date,destination_region,business_segment,package_type,penalty_days',
    `Spec illustrative lookup,${EXPECTED},45,true,4200,2026-11-21,2026-12-11,2026-12-20,Europe,OTA - Cruise,optional,60`,
  ].join('\n');
  expect(
    (
      await send(
        'POST',
        `/v1/rate-manuals/${id}/parity-cases?source=Synthetic%20workbook&rateDate=2026-11-01`,
        analyst,
        csv,
        { 'content-type': 'text/csv' },
      )
    ).statusCode,
  ).toBe(201);
  await send('POST', `/v1/rate-manuals/${id}/parity-runs`, analyst);
  await fileInDelaware({ itemType: 'rate_manual', itemReference: 'RETR-SP-VU-DE-0426' });
  const pub = await send('POST', `/v1/rate-manuals/${id}/publish`, analyst2);
  expect(pub.statusCode, pub.body).toBe(200);
}

const CASE_INPUT = {
  rateDate: '2026-11-01',
  travellers: [{ id: 'A', age: 45, preExistingWaived: true, costPerTraveller: '4200' }],
  trip: SPEC_ILLUSTRATIVE_REQUEST.trip,
  account: SPEC_ILLUSTRATIVE_REQUEST.account,
};

const check = (r: { checks: { check: string; passed: boolean; detail: string }[] }, name: string) =>
  r.checks.find((c) => c.check === name)!;

describe('plan builder (E01-F03) and publishing (E01-F04, E10-F01-S02)', () => {
  it('checks values against the filed range as they are entered, and applies maker-checker', async () => {
    const { catalogue } = await approvedCatalogue();
    const base = (
      await send('POST', '/v1/plans', product, {
        kind: 'base',
        code: 'BASE-TC',
        name: 'Base',
        term: 'single_trip',
        catalogueId: catalogue,
        effectiveFrom: '2026-01-01',
      })
    ).json();
    const draft = base.draft.id as string;
    const outside = await send('PUT', `/v1/plan-versions/${draft}`, product, {
      document: { ...BASE_DOC, values: { ...BASE_DOC.values, 'schedule:tc_max': 20_000 } },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().detail).toBe(
      'Trip Cancellation maximum must be between 500 and 10000 (filed range).',
    );
    const review = await send('PUT', `/v1/plan-versions/${draft}`, product, {
      document: { ...BASE_DOC, settings: [{ ...BASE_DOC.settings[0], value: 16 }] },
    });
    expect(review.json().detail).toBe(
      'Review period must be between 10 days and 15 days (filed range).',
    );

    // Incomplete drafts are saved with their problems listed, but cannot be approved.
    const partial = await send('PUT', `/v1/plan-versions/${draft}`, product, {
      document: { ...BASE_DOC, values: { 'schedule:tc_max': 5000 } },
    });
    expect(partial.statusCode, partial.body).toBe(200);
    expect(partial.json().problems).toEqual([
      { path: 'values.schedule:tc_basis', message: 'Trip Cancellation basis needs a value.' },
    ]);
    expect(
      (
        await send('POST', `/v1/plan-versions/${draft}/approve`, compliance, {
          note: 'Not finished.',
        })
      ).statusCode,
    ).toBe(400);

    await send('PUT', `/v1/plan-versions/${draft}`, builder2, { document: BASE_DOC });
    for (const who of [product, builder2]) {
      expect(
        (await send('POST', `/v1/plan-versions/${draft}/approve`, who, { note: 'My own work.' }))
          .statusCode,
      ).toBe(403);
    }
    const ok = await send('POST', `/v1/plan-versions/${draft}/approve`, compliance, {
      note: 'Checked against the schedule.',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', approvedBy: 'compliance-1' });
    expect(
      (await send('PUT', `/v1/plan-versions/${draft}`, product, { document: BASE_DOC })).statusCode,
    ).toBe(409);

    // Base plans are templates: never published.
    const ready = (await send('GET', `/v1/plan-versions/${draft}/readiness`, product)).json();
    expect(ready.ready).toBe(false);
    expect(check(ready, 'forms_filed').detail).toContain('Base plans are templates');
  });

  it('publishes a state plan only when forms are filed, manuals published and test cases pass', async () => {
    const { catalogue, edition } = await approvedCatalogue();
    const baseId = await approvedBasePlan(catalogue);
    const de = await send('POST', '/v1/plans', product, {
      kind: 'state',
      code: 'TC-DE',
      name: 'Trip Cancellation, Delaware (synthetic)',
      parentPlanId: baseId,
      state: 'DE',
      effectiveFrom: '2026-01-01',
    });
    expect(de.statusCode, de.body).toBe(201);
    expect(de.json().draft.document.bounds).toEqual({});
    expect(de.json().draft.document.values).toEqual(BASE_DOC.values);
    const planId = de.json().plan.id as string;
    const v1 = de.json().draft.id as string;
    expect(
      (
        await send('POST', `/v1/plan-versions/${v1}/approve`, compliance, {
          note: 'State plan checked.',
        })
      ).statusCode,
    ).toBe(200);

    let ready = (await send('GET', `/v1/plan-versions/${v1}/readiness`, product)).json();
    expect(ready.ready).toBe(false);
    expect(check(ready, 'forms_filed')).toMatchObject({
      passed: false,
      detail: 'test_sch (2026-04): No filing is recorded for DE.',
    });
    expect(check(ready, 'manuals').detail).toBe(
      'No published TCAN manual in effect in DE on 2026-01-01.',
    );
    expect(check(ready, 'tests').detail).toBe('Add at least one rating test case for this plan.');
    const refused = await send('POST', `/v1/plan-versions/${v1}/publish`, compliance);
    expect(refused.statusCode).toBe(412);
    expect(refused.json().errors.map((e: { field: string }) => e.field)).toEqual([
      'forms_filed',
      'manuals',
      'tests',
    ]);

    await delawareInReferenceData();
    await fileInDelaware({ itemType: 'form_edition', itemId: edition });
    await publishedManual();

    // A test case with the wrong expectation fails, to the cent; fixing it makes the run stale.
    const bad = await send('POST', `/v1/plans/${planId}/test-cases`, product, {
      name: 'One traveller, spec trip',
      input: CASE_INPUT,
      expected: { perBenefit: { TCAN: '99.99' } },
    });
    expect(bad.statusCode, bad.body).toBe(201);
    const failed = (await send('POST', `/v1/plan-versions/${v1}/test-runs`, product)).json();
    expect(failed).toMatchObject({ total: 1, passed: 0 });
    expect(failed.results[0].message).toBe(`Differs: TCAN ${EXPECTED}, expected 99.99.`);
    await send('POST', `/v1/plans/${planId}/test-cases`, product, {
      name: 'One traveller, spec trip',
      input: CASE_INPUT,
      expected: { perBenefit: { TCAN: EXPECTED }, policyTotal: EXPECTED },
    });
    ready = (await send('GET', `/v1/plan-versions/${v1}/readiness`, product)).json();
    expect(check(ready, 'tests').detail).toBe(
      'The test cases changed since the last run; run them again.',
    );
    expect((await send('POST', `/v1/plan-versions/${v1}/test-runs`, product)).json()).toMatchObject(
      { total: 1, passed: 1 },
    );

    ready = (await send('GET', `/v1/plan-versions/${v1}/readiness`, product)).json();
    expect(ready.ready, JSON.stringify(ready.checks)).toBe(true);
    // Product managers who did not build the version may publish; the publication records the linked forms and manuals.
    const pub = await send('POST', `/v1/plan-versions/${v1}/publish`, compliance);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json()).toMatchObject({ status: 'published', publishedBy: 'compliance-1' });
    const client = await t.pool.connect();
    try {
      const links = (
        await client.query(`SELECT links FROM plans.plan_versions WHERE id = $1`, [v1])
      ).rows[0].links;
      expect(links).toEqual({ schedule: 'test_sch ed. 2026-04', TCAN: 'RETR-SP-VU-DE-0426 v1' });
      // The outbox is row-level secured; the platform sees every account's events.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.account_ids', '*', true)`);
      expect(
        (await client.query(`SELECT 1 FROM platform.outbox WHERE type = 'PlanVersionPublished'`))
          .rowCount,
      ).toBe(1);
      await client.query('COMMIT');
      // Published versions never change.
      await expect(
        client.query(`UPDATE plans.plan_versions SET document = '{}' WHERE id = $1`, [v1]),
      ).rejects.toThrow(/content cannot change/);
    } finally {
      client.release();
    }

    // A new draft copies the published version; the comparison lists what changed.
    const v2 = await send('POST', `/v1/plans/${planId}/drafts`, product, {
      effectiveFrom: '2027-01-01',
    });
    expect(v2.statusCode, v2.body).toBe(201);
    expect(v2.json()).toMatchObject({ version: 2, status: 'draft' });
    await send('PUT', `/v1/plan-versions/${v2.json().id}`, product, {
      document: { ...v2.json().document, values: { ...BASE_DOC.values, 'schedule:tc_max': 6000 } },
    });
    const diff = (
      await send('GET', `/v1/plan-versions/${v2.json().id}/compare?with=${v1}`, product)
    ).json();
    expect(diff.changes).toEqual([
      { area: 'value', item: 'schedule:tc_max', change: 'changed', before: '5000', after: '6000' },
      {
        area: 'dates',
        item: 'effective from',
        change: 'changed',
        before: '2026-01-01',
        after: '2027-01-01',
      },
    ]);
    expect(
      (await send('POST', `/v1/plans/${planId}/drafts`, product, { effectiveFrom: '2027-01-01' }))
        .statusCode,
    ).toBe(409);

    // Account plans change only what the base plan leaves open, within its bounds (E01-F03-S04).
    const accountId = await insertAccount(t.pool, 'ACME');
    const acct = await send('POST', '/v1/plans', product, {
      kind: 'account',
      code: 'TC-DE-ACME',
      name: 'Trip Cancellation, Delaware, ACME (synthetic)',
      parentPlanId: planId,
      accountId,
      effectiveFrom: '2026-02-01',
    });
    expect(acct.statusCode, acct.body).toBe(201);
    expect(acct.json().plan).toMatchObject({ kind: 'account', state: 'DE', accountId });
    const av = acct.json().draft;
    const within = await send('PUT', `/v1/plan-versions/${av.id}`, product, {
      document: { ...av.document, values: { ...av.document.values, 'schedule:tc_max': 7500 } },
    });
    expect(within.statusCode, within.body).toBe(200);
    const beyond = await send('PUT', `/v1/plan-versions/${av.id}`, product, {
      document: { ...av.document, values: { ...av.document.values, 'schedule:tc_max': 9000 } },
    });
    expect(beyond.json().detail).toBe(
      'Trip Cancellation maximum must be between 1000 and 8000 for account plans.',
    );
    const fixed = await send('PUT', `/v1/plan-versions/${av.id}`, product, {
      document: {
        ...av.document,
        values: { ...av.document.values, 'schedule:tc_basis': 'PER TRIP' },
      },
    });
    expect(fixed.json().detail).toBe('Trip Cancellation basis is fixed by the base plan.');
  });

  it('makes a state plan only from a base plan with an approved version', async () => {
    const { catalogue } = await approvedCatalogue();
    const base = (
      await send('POST', '/v1/plans', product, {
        kind: 'base',
        code: 'BASE-TC',
        name: 'Base',
        term: 'single_trip',
        catalogueId: catalogue,
        effectiveFrom: '2026-01-01',
      })
    ).json();
    const early = await send('POST', '/v1/plans', product, {
      kind: 'state',
      code: 'TC-DE',
      name: 'Delaware',
      parentPlanId: base.plan.id,
      state: 'DE',
      effectiveFrom: '2026-01-01',
    });
    expect(early.statusCode).toBe(412);
    expect(early.json().detail).toBe('BASE-TC has no approved version yet.');
    const dup = await send('POST', '/v1/plans', product, {
      kind: 'base',
      code: 'BASE-TC',
      name: 'Again',
      term: 'single_trip',
      catalogueId: catalogue,
      effectiveFrom: '2026-01-01',
    });
    expect(dup.statusCode).toBe(409);
    // Rating analysts read plans but do not build them.
    expect((await send('GET', '/v1/plans', analyst)).statusCode).toBe(200);
    expect(
      (
        await send('POST', '/v1/plans', analyst, {
          kind: 'base',
          code: 'X-1',
          name: 'X1',
          term: 'annual',
          catalogueId: catalogue,
          effectiveFrom: '2026-01-01',
        })
      ).statusCode,
    ).toBe(403);
  });
});
