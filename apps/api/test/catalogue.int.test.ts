/**
 * Increment 4: benefit catalogue (E01-F02-S01/S02/S03) through the API and database.
 * The schedule below is synthetic: benefit names follow the specification's list (section 5.2), the
 * bracketed amounts are invented for the test. No filed schedule has been provided yet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
let product: string;
let analyst: string;
let compliance: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await resetDatabase();
  product = await t.idp.token({ roles: ['product_manager'], sub: 'product-1' });
  analyst = await t.idp.token({ roles: ['rating_analyst'], sub: 'analyst-1' });
  compliance = await t.idp.token({ roles: ['compliance_officer'], sub: 'compliance-1' });
});

let n = 0;
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { ...bearer(token), 'idempotency-key': `cat-${Date.now()}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(product) });

const SCHEDULE = [
  'SCHEDULE OF BENEFITS (synthetic test schedule)',
  'Accident and Sickness Medical Expense [$10,000-$500,000] [PER PERSON] [PER TRIP]',
  'Dental [$100-$1,000]',
  'Medical Evacuation and Repatriation of Remains [$50,000-$1,000,000]',
  '[[Optional] Increased Medical Benefit Package: Medical [$100,000-$1,000,000] Evacuation [$500,000-$2,000,000]]',
].join('\n');

/** Loads the synthetic schedule and approves its variable map (built by one person, approved by another). */
async function scheduleWithMap(): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/form-editions?formNumber=test_sch&edition=2026-04&title=Synthetic%20schedule&kind=schedule&insurer=VSC&fileName=s.txt',
    headers: { ...bearer(compliance), 'content-type': 'text/plain' },
    payload: Buffer.from(SCHEDULE),
  });
  expect(res.statusCode, res.body).toBe(201);
  const ed = res.json().id as string;
  const map = (await send('POST', `/v1/form-editions/${ed}/maps`, product)).json().id as string;
  const spans = (await get(`/v1/form-editions/${ed}/brackets`)).json().items as {
    start: number;
    end: number;
    text: string;
    suggestion: { type: string; constraints: Record<string, unknown> } | null;
  }[];
  const keys: Record<string, string> = {
    '[$10,000-$500,000]': 'med_max',
    '[PER PERSON] [PER TRIP]': 'med_basis',
    '[$100-$1,000]': 'med_dental',
    '[$50,000-$1,000,000]': 'evac_max',
    '[$100,000-$1,000,000]': 'imbp_med',
    '[$500,000-$2,000,000]': 'imbp_evac',
  };
  for (const s of spans) {
    const key = s.text.startsWith('[[Optional]') ? 'imbp_offered' : keys[s.text];
    if (!key) continue;
    const r = await send('PUT', `/v1/variable-maps/${map}/variables/${key}`, product, {
      key,
      label: key,
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
  return ed;
}

const sv = (key: string) => ({ source: 'schedule', key });
const perPerson = { kind: 'fixed', basis: 'per_person' };

describe('benefit catalogue (E01-F02)', () => {
  it('needs a schedule edition with an approved variable map', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/form-editions?formNumber=test_sch&edition=2026-04&title=Synthetic&kind=schedule&insurer=VSC&fileName=s.txt',
      headers: { ...bearer(compliance), 'content-type': 'text/plain' },
      payload: Buffer.from(SCHEDULE),
    });
    expect(
      (await send('POST', `/v1/form-editions/${res.json().id}/catalogues`, product, {})).statusCode,
    ).toBe(412);
  });

  it('builds benefits, reasons and upgrades, checks them against the map, and applies maker-checker', async () => {
    const ed = await scheduleWithMap();
    const start = await send('POST', `/v1/form-editions/${ed}/catalogues`, product, {});
    expect(start.statusCode, start.body).toBe(201);
    const id = start.json().id as string;
    const put = (path: string, token: string, body: Record<string, unknown>) =>
      send('PUT', `/v1/benefit-catalogues/${id}/${path}/${body.code as string}`, token, body);

    // A benefit with a plan-chosen basis, a deductible-free maximum and an included sub-limit.
    const medical = await put('benefits', product, {
      code: 'medical',
      name: 'Accident and Sickness Medical Expense',
      group: 'medical_evacuation',
      maximum: { variable: sv('med_max'), basis: { kind: 'variable', variable: sv('med_basis') } },
      subLimits: [
        {
          code: 'dental',
          name: 'Dental',
          amount: { variable: sv('med_dental'), basis: perPerson },
          includedInParent: true,
        },
      ],
    });
    expect(medical.statusCode, medical.body).toBe(200);
    expect(medical.json().document.benefits[0].subLimits[0].includedInParent).toBe(true);

    // References are checked by type against the approved map as they are saved.
    const wrongType = await put('benefits', product, {
      code: 'evacuation',
      name: 'Medical Evacuation',
      group: 'medical_evacuation',
      maximum: { variable: sv('med_basis'), basis: perPerson },
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().detail).toContain('is a limit basis; an amount needs a numeric range');
    const missing = await put('benefits', product, {
      code: 'evacuation',
      name: 'Medical Evacuation',
      group: 'medical_evacuation',
      maximum: { variable: sv('nowhere'), basis: perPerson },
    });
    expect(missing.statusCode).toBe(400);
    expect(
      (
        await put('benefits', analyst, {
          code: 'evacuation',
          name: 'Medical Evacuation and Repatriation of Remains',
          group: 'medical_evacuation',
          maximum: { variable: sv('evac_max'), basis: perPerson },
        })
      ).statusCode,
    ).toBe(200);

    // The upgrade that replaces the base medical and evacuation limits.
    const imbp = await put('upgrades', product, {
      code: 'imbp',
      name: 'Increased Medical Benefit Package',
      kind: 'limit_replacement',
      offeredBy: sv('imbp_offered'),
      replacements: [
        {
          target: { kind: 'benefit', benefit: 'medical', field: 'maximum' },
          amount: { variable: sv('imbp_med'), basis: perPerson },
        },
        {
          target: { kind: 'benefit', benefit: 'evacuation', field: 'maximum' },
          amount: { variable: sv('imbp_evac'), basis: perPerson },
        },
      ],
    });
    expect(imbp.statusCode, imbp.body).toBe(200);

    // A covered reason may be saved before its peril number is known, but blocks approval.
    const reason = await put('covered-reasons', product, {
      code: 'sickness_self',
      text: 'Sickness, injury or death (synthetic wording)',
      category: 'Medical and Health',
      appliesTo: ['trip_cancellation', 'trip_interruption'],
      coverageLevels: ['self', 'family_member', 'travelling_companion'],
    });
    expect(reason.statusCode, reason.body).toBe(200);
    expect(reason.json().problems).toEqual([
      {
        path: 'coveredReasons.sickness_self.perilNumber',
        message: 'The peril number from the rating manual is missing.',
      },
    ]);
    const blocked = await send('POST', `/v1/benefit-catalogues/${id}/approve`, compliance, {
      note: 'Ready?' + ' Checked.',
    });
    expect(blocked.statusCode).toBe(412);
    expect(blocked.body).toContain('peril number');

    await put('covered-reasons', product, {
      code: 'sickness_self',
      text: 'Sickness, injury or death (synthetic wording)',
      category: 'Medical and Health',
      appliesTo: ['trip_cancellation', 'trip_interruption'],
      coverageLevels: ['self', 'family_member', 'travelling_companion'],
      perilNumber: '1',
    });

    // Neither builder may approve; a third person can.
    expect(
      (
        await send('POST', `/v1/benefit-catalogues/${id}/approve`, product, {
          note: 'My own work.',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send('POST', `/v1/benefit-catalogues/${id}/approve`, analyst, {
          note: 'I edited it.',
        })
      ).statusCode,
    ).toBe(403);
    const ok = await send('POST', `/v1/benefit-catalogues/${id}/approve`, compliance, {
      note: 'Matches the test schedule.',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', version: 1, problems: [] });

    // Approved catalogues never change, in the API or the database.
    expect(
      (await send('DELETE', `/v1/benefit-catalogues/${id}/benefits/evacuation`, product))
        .statusCode,
    ).toBe(409);
    const client = await t.pool.connect();
    try {
      await expect(
        client.query(`UPDATE studio.benefit_catalogues SET document = '{}' WHERE id = $1`, [id]),
      ).rejects.toThrow(/only be superseded/);
    } finally {
      client.release();
    }

    // A new version starts from the approved one and supersedes it on approval.
    const v2 = await send('POST', `/v1/form-editions/${ed}/catalogues`, analyst, {});
    expect(v2.json()).toMatchObject({ version: 2, status: 'draft' });
    expect(v2.json().document.benefits).toHaveLength(2);
    await send(
      'DELETE',
      `/v1/benefit-catalogues/${v2.json().id}/covered-reasons/sickness_self`,
      analyst,
    );
    expect(
      (
        await send('POST', `/v1/benefit-catalogues/${v2.json().id}/approve`, product, {
          note: 'Reason moved to a later version.',
        })
      ).statusCode,
    ).toBe(200);
    expect((await get(`/v1/benefit-catalogues/${id}`)).json().status).toBe('superseded');
    const list = (await get(`/v1/form-editions/${ed}/catalogues`)).json().items;
    expect(
      list.map((c: { version: number; status: string; coveredReasons: number }) => [
        c.version,
        c.status,
        c.coveredReasons,
      ]),
    ).toEqual([
      [2, 'approved', 0],
      [1, 'superseded', 1],
    ]);
  });

  it('refuses replacement targets that do not exist, and only one draft at a time', async () => {
    const ed = await scheduleWithMap();
    const id = (await send('POST', `/v1/form-editions/${ed}/catalogues`, product, {})).json().id;
    expect((await send('POST', `/v1/form-editions/${ed}/catalogues`, analyst, {})).statusCode).toBe(
      409,
    );
    const bad = await send('PUT', `/v1/benefit-catalogues/${id}/upgrades/imbp`, product, {
      code: 'imbp',
      name: 'Increased Medical Benefit Package',
      kind: 'limit_replacement',
      offeredBy: sv('imbp_offered'),
      replacements: [
        {
          target: { kind: 'benefit', benefit: 'medical', field: 'maximum' },
          amount: { variable: sv('imbp_med'), basis: perPerson },
        },
      ],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toBe('No benefit medical in this catalogue.');
    // Policy references need a policy form.
    const noPolicy = await send('PUT', `/v1/benefit-catalogues/${id}/upgrades/reasons`, product, {
      code: 'reasons',
      name: 'Employment reasons',
      kind: 'covered_reason_set',
      offeredBy: { source: 'policy', key: 'x_offered' },
    });
    expect(noPolicy.statusCode).toBe(400);
    expect(noPolicy.json().detail).toContain('no policy form');
  });
});
