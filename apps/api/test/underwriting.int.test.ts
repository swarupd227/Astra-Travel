/**
 * Increment 7: underwriting and eligibility rules (E03) through the API and database.
 * Everything is synthetic: the schedule's ranges, the plan limits, the referral rule and the sanctions
 * entries (fictional names in the published SDN.CSV layout) are invented for the tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
let product: string;
let compliance: string;
let uw1: string;
let uw2: string;
let analyst: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await resetDatabase();
  product = await t.idp.token({ roles: ['product_manager'], sub: 'product-1' });
  compliance = await t.idp.token({ roles: ['compliance_officer'], sub: 'compliance-1' });
  uw1 = await t.idp.token({ roles: ['underwriter'], sub: 'uw-1', name: 'Uma Underwriter' });
  uw2 = await t.idp.token({ roles: ['underwriter'], sub: 'uw-2', name: 'Ulrich Underwriter' });
  analyst = await t.idp.token({ roles: ['rating_analyst'], sub: 'analyst-1' });
});

let n = 0;
const send = (
  method: 'POST' | 'PUT' | 'DELETE' | 'GET',
  url: string,
  token: string,
  payload?: unknown,
) =>
  t.app.inject({
    method,
    url,
    headers: { ...bearer(token), 'idempotency-key': `uw-${Date.now()}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const NOTICE =
  'The traveller confirms they are medically able to travel and are not under restricting treatment.';
const SCHEDULE = [
  'SCHEDULE OF BENEFITS (synthetic test schedule)',
  'Trip Cancellation maximum [$500-$10,000] per person',
  'The time-sensitive period is [ten (10) - twenty (20)] days.',
  'CFAR trip cost cap [$1,000-$50,000]',
  'CFAR cancellation notice [seven (7) - fourteen (14)] days.',
  `ELIGIBILITY NOTICE (synthetic): ${NOTICE}`,
].join('\n');

/** A state plan version (approved) with the time-sensitive period, CFAR cap and notice set. */
async function statePlan(): Promise<{ planId: string; versionId: string }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/form-editions?formNumber=uw_sch&edition=2026-04&title=Synthetic%20schedule&kind=schedule&insurer=VSC&fileName=s.txt',
    headers: { ...bearer(compliance), 'content-type': 'text/plain' },
    payload: Buffer.from(SCHEDULE),
  });
  expect(res.statusCode, res.body).toBe(201);
  const ed = res.json().id as string;
  const map = (await send('POST', `/v1/form-editions/${ed}/maps`, product)).json().id as string;
  const spans = (await send('GET', `/v1/form-editions/${ed}/brackets`, product)).json().items as {
    start: number;
    end: number;
    text: string;
    suggestion: { type: string; constraints: Record<string, unknown> } | null;
  }[];
  const keys: Record<string, string> = {
    '[$500-$10,000]': 'tc_max',
    '[ten (10) - twenty (20)]': 'ts_period',
    '[$1,000-$50,000]': 'cfar_cap',
    '[seven (7) - fourteen (14)]': 'cfar_notice',
  };
  for (const s of spans) {
    const key = keys[s.text];
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
  const cat = (await send('POST', `/v1/form-editions/${ed}/catalogues`, product, {})).json()
    .id as string;
  await send('PUT', `/v1/benefit-catalogues/${cat}/benefits/trip_cancellation`, product, {
    code: 'trip_cancellation',
    name: 'Trip Cancellation',
    group: 'pre_departure',
    maximum: {
      variable: { source: 'schedule', key: 'tc_max' },
      basis: { kind: 'fixed', basis: 'per_person' },
    },
  });
  await send('PUT', `/v1/benefit-catalogues/${cat}/covered-reasons/sickness`, product, {
    code: 'sickness',
    text: 'Sickness (synthetic wording)',
    category: 'Medical and Health',
    appliesTo: ['trip_cancellation'],
    coverageLevels: ['self'],
    perilNumber: '1',
  });
  expect(
    (
      await send('POST', `/v1/benefit-catalogues/${cat}/approve`, compliance, {
        note: 'Matches the test schedule.',
      })
    ).statusCode,
  ).toBe(200);

  const base = await send('POST', '/v1/plans', product, {
    kind: 'base',
    code: 'UW-BASE',
    name: 'Underwriting base plan',
    term: 'single_trip',
    catalogueId: cat,
    effectiveFrom: '2026-01-01',
  });
  const v = (name: string, key: string) => ({
    setting: name,
    variable: { source: 'schedule', key },
  });
  const saved = await send('PUT', `/v1/plan-versions/${base.json().draft.id}`, product, {
    document: {
      benefits: [{ code: 'trip_cancellation', packaging: 'packaged' }],
      coveredReasons: [{ code: 'sickness', levels: ['self'] }],
      values: { 'schedule:tc_max': 5000 },
      settings: [
        { ...v('time_sensitive_period', 'ts_period'), value: 20 },
        { ...v('cfar_trip_cost_cap', 'cfar_cap'), value: 10000 },
        { ...v('cfar_notice_period', 'cfar_notice'), value: 14 },
      ],
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(
    (
      await send('POST', `/v1/plan-versions/${base.json().draft.id}/approve`, compliance, {
        note: 'Base plan checked.',
      })
    ).statusCode,
  ).toBe(200);
  const state = await send('POST', '/v1/plans', product, {
    kind: 'state',
    code: 'UW-DE',
    name: 'Underwriting plan, Delaware',
    parentPlanId: base.json().plan.id,
    state: 'DE',
    effectiveFrom: '2026-01-01',
  });
  expect(state.statusCode, state.body).toBe(201);
  expect(
    (
      await send('POST', `/v1/plan-versions/${state.json().draft.id}/approve`, compliance, {
        note: 'State plan checked.',
      })
    ).statusCode,
  ).toBe(200);
  return { planId: state.json().plan.id, versionId: state.json().draft.id };
}

const RULES = {
  limits: [{ code: 'max_age', kind: 'max_age', value: 75 }],
  referralRules: [
    {
      code: 'high_cost',
      name: 'High trip cost',
      when: { field: 'cost_per_traveller', op: 'gt', value: 8000 },
      action: 'recommend_decline',
      reason: 'Trip cost is unusually high for this plan.',
    },
  ],
  timeBasedBenefits: [{ benefit: 'trip_cancellation' }],
  duplicates: { enabled: true, allowSingleAndAnnual: true },
};

const trip = {
  purchaseDate: '2026-11-21',
  initialDepositDate: '2026-11-10',
  departureDate: '2026-12-11',
  returnDate: '2026-12-20',
  destinations: [{ country: 'FR', region: 'Europe' }],
};
const input = (over: Record<string, unknown> = {}, traveller: Record<string, unknown> = {}) => ({
  stage: 'quote',
  travellers: [
    {
      id: 'A',
      firstName: 'Pat',
      lastName: 'Sample',
      dateOfBirth: '1980-05-05',
      age: 45,
      costPerTraveller: '4200',
      ...traveller,
    },
  ],
  trip,
  insuredPercent: 100,
  ableToTravel: true,
  benefits: ['trip_cancellation'],
  ...over,
});

async function publishedRuleSet(planId: string): Promise<string> {
  const rs = await send('POST', `/v1/plans/${planId}/rule-sets`, uw1, {
    effectiveFrom: '2026-01-01',
  });
  expect(rs.statusCode, rs.body).toBe(201);
  const id = rs.json().id as string;
  expect((await send('PUT', `/v1/rule-sets/${id}`, uw1, { document: RULES })).statusCode).toBe(200);
  const cases = [
    {
      name: 'Typical adult',
      input: input(),
      expected: { outcome: 'eligible', waiver: true, cfarOffered: true },
    },
    {
      name: 'Too old',
      input: input({}, { age: 80 }),
      expected: { outcome: 'ineligible', reasonsInclude: ['Maximum age'] },
    },
    {
      name: 'High cost',
      input: input({}, { costPerTraveller: '9000' }),
      expected: { outcome: 'referred', referralRules: ['high_cost'] },
    },
  ];
  for (const c of cases)
    expect((await send('POST', `/v1/plans/${planId}/rule-test-cases`, uw1, c)).statusCode).toBe(
      201,
    );
  expect(
    (await send('POST', `/v1/rule-sets/${id}/approve`, uw2, { note: 'Limits and rule checked.' }))
      .statusCode,
  ).toBe(200);
  const run = await send('POST', `/v1/rule-sets/${id}/test-runs`, uw1);
  expect(run.json()).toMatchObject({ total: 3, passed: 3 });
  const pub = await send('POST', `/v1/rule-sets/${id}/publish`, uw2);
  expect(pub.statusCode, pub.body).toBe(200);
  return id;
}

const SDN = [
  '9001,"TESTBURG, Zorbek Quill",individual,SYNTH-PROGRAM,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 12 Mar 1970"',
  '9002,"ACME SYNTHETIC TRADING LLC",-0-,SYNTH-PROGRAM,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-',
].join('\r\n');

async function approvedSanctionsList() {
  const l = await send('POST', '/v1/sanctions-lists', compliance, {
    source: 'Synthetic test list in SDN.CSV layout',
    publishedOn: '2026-11-01',
    sdnCsv: SDN,
    altCsv: '9001,1,aka,"Z. Testburg",-0-',
  });
  expect(l.statusCode, l.body).toBe(201);
  expect(l.json()).toMatchObject({ entries: 1, aliases: 1, status: 'draft' });
  return l.json().id as string;
}

describe('rule sets (E03-F05-S02)', () => {
  it('are approved by a second person and published only when every test passes', async () => {
    const { planId } = await statePlan();
    const rs = await send('POST', `/v1/plans/${planId}/rule-sets`, uw1, {
      effectiveFrom: '2026-01-01',
    });
    const id = rs.json().id as string;
    const saved = await send('PUT', `/v1/rule-sets/${id}`, uw1, { document: RULES });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().problems).toEqual([]);

    // Problems block approval: a time condition naming a benefit the catalogue does not have.
    const bad = await send('PUT', `/v1/rule-sets/${id}`, uw1, {
      document: { ...RULES, timeBasedBenefits: [{ benefit: 'lost_activity_day' }] },
    });
    expect(bad.json().problems).toEqual([
      {
        path: 'timeBasedBenefits.lost_activity_day',
        message: 'The catalogue has no benefit lost_activity_day.',
      },
    ]);
    expect(
      (await send('POST', `/v1/rule-sets/${id}/approve`, uw2, { note: 'Looks fine.' })).statusCode,
    ).toBe(400);
    await send('PUT', `/v1/rule-sets/${id}`, uw1, { document: RULES });

    expect(
      (await send('POST', `/v1/rule-sets/${id}/approve`, uw1, { note: 'My own work.' })).statusCode,
    ).toBe(403);
    expect(
      (await send('POST', `/v1/rule-sets/${id}/approve`, analyst, { note: 'Not an approver.' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await send('POST', `/v1/rule-sets/${id}/approve`, uw2, { note: 'Limits and rule checked.' }))
        .statusCode,
    ).toBe(200);

    // No tests yet; then a case that expects the wrong outcome; then fixed. Each change makes the last run stale.
    let ready = (await send('GET', `/v1/rule-sets/${id}/readiness`, uw1)).json();
    expect(ready.checks.find((c: { check: string }) => c.check === 'tests').detail).toBe(
      'Add at least one test case for this plan.',
    );
    expect((await send('POST', `/v1/rule-sets/${id}/publish`, uw2)).statusCode).toBe(412);
    const wrong = {
      name: 'Too old',
      input: input({}, { age: 80 }),
      expected: { outcome: 'eligible' },
    };
    await send('POST', `/v1/plans/${planId}/rule-test-cases`, uw1, wrong);
    const failed = (await send('POST', `/v1/rule-sets/${id}/test-runs`, uw1)).json();
    expect(failed).toMatchObject({ total: 1, passed: 0 });
    expect(failed.results[0].message).toBe('Differs: outcome ineligible, expected eligible.');
    const refused = await send('POST', `/v1/rule-sets/${id}/publish`, uw2);
    expect(refused.statusCode).toBe(412);
    expect(refused.json().detail).toContain('0 of 1 test cases pass');

    await send('POST', `/v1/plans/${planId}/rule-test-cases`, uw1, {
      ...wrong,
      expected: {
        outcome: 'ineligible',
        reasonsInclude: ['Maximum age for this plan is 75 years; this traveller is 80.'],
      },
    });
    ready = (await send('GET', `/v1/rule-sets/${id}/readiness`, uw1)).json();
    expect(ready.checks.find((c: { check: string }) => c.check === 'tests').detail).toContain(
      'changed since the last run',
    );
    expect((await send('POST', `/v1/rule-sets/${id}/test-runs`, uw1)).json()).toMatchObject({
      total: 1,
      passed: 1,
    });
    const pub = await send('POST', `/v1/rule-sets/${id}/publish`, uw2);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().status).toBe('published');

    // Published rule sets never change; the next version starts from them.
    expect((await send('PUT', `/v1/rule-sets/${id}`, uw1, { document: RULES })).statusCode).toBe(
      409,
    );
    const client = await t.pool.connect();
    try {
      await expect(
        client.query(`UPDATE underwriting.rule_sets SET document = '{}' WHERE id = $1`, [id]),
      ).rejects.toThrow(/content cannot change/);
    } finally {
      client.release();
    }
    const v2 = await send('POST', `/v1/plans/${planId}/rule-sets`, uw1, {
      effectiveFrom: '2027-01-01',
    });
    expect(v2.json()).toMatchObject({ version: 2, status: 'draft' });
    expect(v2.json().document.limits).toEqual(RULES.limits);
  });
});

describe('evaluation (E03-F01 to E03-F04)', () => {
  it('decides eligibility with every check, and the waiver and CFAR results', async () => {
    const { planId, versionId } = await statePlan();
    const rs = await publishedRuleSet(planId);
    const ok = await send('POST', '/v1/underwriting/evaluate', uw1, {
      planVersionId: versionId,
      input: input(),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const r = ok.json();
    expect(r).toMatchObject({
      outcome: 'eligible',
      ruleSet: { id: rs, version: 1 },
      preview: true,
    });
    expect(r.waiver).toMatchObject({ applies: true, timeSensitiveDays: 20 });
    expect(r.cfar).toMatchObject({ passed: true, offered: true, noticePeriod: 14 });
    expect(r.benefitAvailability).toEqual([
      {
        benefit: 'trip_cancellation',
        available: true,
        reason: 'Bought within the time-sensitive period.',
      },
    ]);

    const late = (
      await send('POST', '/v1/underwriting/evaluate', uw1, {
        planVersionId: versionId,
        input: input({ trip: { ...trip, purchaseDate: '2026-12-05' } }),
      })
    ).json();
    expect(late.waiver.applies).toBe(false);
    expect(late.cfar.offered).toBe(false);
    expect(late.benefitAvailability[0].available).toBe(false);

    // No rule set in effect before it starts.
    const early = await send('POST', '/v1/underwriting/evaluate', uw1, {
      planVersionId: versionId,
      input: input({ asOf: '2025-06-01' }),
    });
    expect(early.statusCode).toBe(412);
    expect(early.json().detail).toContain('No published rule set is in effect');

    // The role matters: rating analysts cannot evaluate.
    expect(
      (
        await send('POST', '/v1/underwriting/evaluate', analyst, {
          planVersionId: versionId,
          input: input(),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('blocks prohibited destinations from the reference data in force', async () => {
    const { planId, versionId } = await statePlan();
    await publishedRuleSet(planId);
    const load = async (dataset: string, entries: unknown[]) => {
      const v = await send('POST', `/v1/reference-data/${dataset}/versions`, analyst, {
        effectiveFrom: '2026-01-01',
        source: 'Synthetic test data',
        entries,
      });
      expect(v.statusCode, v.body).toBe(201);
      expect(
        (
          await send(
            'POST',
            `/v1/reference-data/${dataset}/versions/${v.json().id}/decision`,
            compliance,
            { decision: 'approve', reason: 'Test data.' },
          )
        ).statusCode,
      ).toBe(200);
    };
    await load('countries', [
      { code: 'FR', alpha3: 'FRA', numeric: '250', name: 'France' },
      { code: 'KP', alpha3: 'PRK', numeric: '408', name: 'Korea, Democratic People’s Republic of' },
    ]);
    await load('prohibited_destinations', [{ country: 'KP', reason: 'Synthetic test exclusion' }]);
    const r = (
      await send('POST', '/v1/underwriting/evaluate', uw1, {
        planVersionId: versionId,
        input: input({ trip: { ...trip, destinations: [{ country: 'KP' }] } }),
      })
    ).json();
    expect(r.outcome).toBe('ineligible');
    expect(r.reasons).toEqual(['Cover is not offered for travel to KP: Synthetic test exclusion.']);
  });

  it('keeps one open referral per case, which an underwriter decides; declines are always a person’s', async () => {
    const { planId, versionId } = await statePlan();
    await publishedRuleSet(planId);
    const body = {
      planVersionId: versionId,
      input: input({}, { costPerTraveller: '9000' }),
      persist: true,
      caseRef: 'QUOTE-1',
    };
    const first = (await send('POST', '/v1/underwriting/evaluate', uw1, body)).json();
    expect(first).toMatchObject({
      outcome: 'referred',
      referrals: [{ rule: 'high_cost', recommendation: 'recommend_decline' }],
    });
    expect(first.referralId).toBeTruthy();
    const again = (await send('POST', '/v1/underwriting/evaluate', uw1, body)).json();
    expect(again.referralId).toBe(first.referralId);
    expect(
      (
        await send('POST', '/v1/underwriting/evaluate', uw1, {
          ...body,
          persist: true,
          caseRef: undefined,
        })
      ).statusCode,
    ).toBe(400);

    const list = (await send('GET', '/v1/referrals?status=open', uw2)).json().items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      caseRef: 'QUOTE-1',
      kind: 'underwriting',
      recommendation: 'recommend_decline',
    });
    const detail = (await send('GET', `/v1/referrals/${first.referralId}`, uw2)).json();
    expect(detail.summary).toContain(
      'Rule high_cost (recommends decline): Trip cost is unusually high for this plan.',
    );

    // Only people with the permission decide; the reason is required.
    expect(
      (
        await send('POST', `/v1/referrals/${first.referralId}/decision`, analyst, {
          decision: 'declined',
          reason: 'Not mine to decide.',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send('POST', `/v1/referrals/${first.referralId}/decision`, uw2, {
          decision: 'declined',
          reason: 'no',
        })
      ).statusCode,
    ).toBe(400);
    const decided = await send('POST', `/v1/referrals/${first.referralId}/decision`, uw2, {
      decision: 'declined',
      reason: 'Trip cost is out of line with the plan.',
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({ status: 'declined', decidedBy: 'uw-2' });
    expect(
      (
        await send('POST', `/v1/referrals/${first.referralId}/decision`, uw1, {
          decision: 'approved',
          reason: 'Second thoughts.',
        })
      ).statusCode,
    ).toBe(409);
    const client = await t.pool.connect();
    try {
      await expect(
        client.query(`UPDATE underwriting.referrals SET summary = 'x' WHERE id = $1`, [
          first.referralId,
        ]),
      ).rejects.toThrow(/cannot change/);
    } finally {
      client.release();
    }
  });

  it('holds the bind on a possible sanctions match until an underwriter clears it', async () => {
    const { planId, versionId } = await statePlan();
    await publishedRuleSet(planId);
    const bind = (traveller: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      send('POST', '/v1/underwriting/evaluate', uw1, {
        planVersionId: versionId,
        input: input({ stage: 'bind' }, traveller),
        ...extra,
      });

    // No approved list: nobody can be cleared at bind.
    const none = (await bind({})).json();
    expect(none.outcome).toBe('held');
    expect(none.screening.listVersion).toBeNull();

    // A list is approved by someone other than the person who loaded it.
    const id = await approvedSanctionsList();
    expect(
      (
        await send('POST', `/v1/sanctions-lists/${id}/decision`, compliance, {
          decision: 'approve',
          reason: 'Matches the published file.',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send('POST', `/v1/sanctions-lists/${id}/decision`, uw1, {
          decision: 'approve',
          reason: 'Matches the published file.',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await send('POST', '/v1/sanctions-lists', compliance, {
          source: 'Same file again',
          sdnCsv: SDN,
          altCsv: '9001,1,aka,"Z. Testburg",-0-',
        })
      ).statusCode,
    ).toBe(409);

    expect((await bind({})).json()).toMatchObject({
      outcome: 'eligible',
      screening: { screened: 1, possibleMatches: [] },
    });
    const hit = await bind(
      { firstName: 'Zorbek', lastName: 'Testburg', dateOfBirth: '1970-03-12' },
      { persist: true, caseRef: 'BIND-1' },
    );
    const held = hit.json();
    expect(held.outcome).toBe('held');
    expect(held.screening.possibleMatches[0]).toMatchObject({ uid: '9001', score: 1 });
    const referral = (await send('GET', `/v1/referrals/${held.referralId}`, uw2)).json();
    expect(referral).toMatchObject({ kind: 'sanctions', status: 'open' });
    expect(referral.summary).toContain('Possible sanctions match');
    expect(
      (await bind({ firstName: 'Z.', lastName: 'Testburg', dateOfBirth: '1970-03-12' })).json()
        .outcome,
    ).toBe('held');

    const cleared = await send('POST', `/v1/referrals/${held.referralId}/decision`, uw2, {
      decision: 'approved',
      reason: 'Different person: date of birth and nationality differ.',
    });
    expect(cleared.json()).toMatchObject({ status: 'approved' });

    // A second list replaces the first.
    const second = await send('POST', '/v1/sanctions-lists', compliance, {
      source: 'Updated synthetic list',
      sdnCsv: SDN.replace('9002', '9003'),
    });
    expect(
      (
        await send('POST', `/v1/sanctions-lists/${second.json().id}/decision`, uw1, {
          decision: 'approve',
          reason: 'Newer file checked.',
        })
      ).statusCode,
    ).toBe(200);
    const lists = (await send('GET', '/v1/sanctions-lists', uw1))
      .json()
      .items.map((l: { status: string }) => l.status);
    expect(lists.sort()).toEqual(['approved', 'superseded']);
  });

  it('refuses a duplicate cover at bind, but allows one single-trip and one annual policy where the rule set does', async () => {
    const { planId, versionId } = await statePlan();
    await publishedRuleSet(planId);
    const listId = await approvedSanctionsList();
    await send('POST', `/v1/sanctions-lists/${listId}/decision`, uw1, {
      decision: 'approve',
      reason: 'Matches the published file.',
    });
    await t.pool.query(
      `INSERT INTO underwriting.cover_register (first_name, last_name, date_of_birth, policy_ref, trip_start, trip_end, term) VALUES ('Pat', 'Sample', '1980-05-05', 'POL-100', '2026-12-15', '2026-12-30', 'single_trip')`,
    );
    const bind = (over: Record<string, unknown> = {}) =>
      send('POST', '/v1/underwriting/evaluate', uw1, {
        planVersionId: versionId,
        input: input({ stage: 'bind', ...over }),
      });
    const dup = (await bind()).json();
    expect(dup.outcome).toBe('ineligible');
    expect(dup.reasons).toEqual([
      'The traveller is already covered by policy POL-100 (2026-12-15 to 2026-12-30), so a second policy for these dates is not allowed.',
    ]);
    expect(dup.duplicates).toMatchObject({ registerRows: 1, matches: [{ policyRef: 'POL-100' }] });
    expect((await bind({ term: 'annual' })).json().outcome).toBe('eligible');
    expect((await bind({ policyRef: 'POL-100' })).json().outcome).toBe('eligible');
  });
});

describe('able-to-travel declaration (E03-F01-S01)', () => {
  it('records the confirmation with the filed wording, its form and its time', async () => {
    const { versionId } = await statePlan();
    const ok = await send('POST', '/v1/underwriting/declarations', uw1, {
      planVersionId: versionId,
      subjectRef: 'QUOTE-9',
      confirmed: true,
      noticeText: `  ${NOTICE.replace('medically', 'medically\n')}  `,
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({
      confirmed: true,
      noticeText: NOTICE,
      formReference: 'uw_sch ed. 2026-04',
      recordedBy: 'uw-1',
    });
    expect(ok.json().textSha256).toMatch(/^[0-9a-f]{64}$/);
    const other = await send('POST', '/v1/underwriting/declarations', uw1, {
      planVersionId: versionId,
      subjectRef: 'QUOTE-9',
      confirmed: true,
      noticeText: 'I am certainly able to travel, honest.',
    });
    expect(other.statusCode).toBe(400);
    expect(other.json().detail).toContain('is not in uw_sch (2026-04)');
    const list = (await send('GET', '/v1/underwriting/declarations?subjectRef=QUOTE-9', uw2)).json()
      .items;
    expect(list).toHaveLength(1);
    const client = await t.pool.connect();
    try {
      await expect(
        client.query(`UPDATE underwriting.declarations SET confirmed = false`),
      ).rejects.toThrow(/cannot be changed|permission denied/);
    } finally {
      client.release();
    }
  });
});
