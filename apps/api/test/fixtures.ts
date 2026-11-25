/**
 * A complete, published stack for quote and bind tests: reference data, an approved sanctions list, a filed
 * schedule with its variable map and benefit catalogue, an approved base plan, a published state plan with
 * its test cases, two published rate manuals and a published rule set.
 *
 * Everything is SYNTHETIC. The rate manuals hold invented one-row tables with a loss cost multiplier of 1, so
 * the arithmetic is easy to follow (base loss cost x trip cost per $100 x age factor); they are not filed
 * rates. Dates are relative to today so the tests do not age.
 */
import { expect } from 'vitest';
import { bearer, insertAccount, type TestContext } from './helpers';

let n = 0;
export const send = (t: TestContext, method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method, url, headers: { ...bearer(token), 'idempotency-key': `fx-${Date.now()}-${n++}`, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

const NOTICE = 'The traveller confirms they are medically able to travel and are not under restricting treatment.';
const SCHEDULE = [
  'SCHEDULE OF BENEFITS (synthetic test schedule)',
  'Trip Cancellation maximum [$500-$10,000] per person',
  'Trip Interruption maximum [$500-$15,000] per person',
  'Trip Delay maximum [$100-$2,000] per person',
  'The time-sensitive period is [ten (10) - twenty (20)] days.',
  'You may cancel within the [ten (10) - fifteen (15)] day review period.',
  `ELIGIBILITY NOTICE (synthetic): ${NOTICE}`,
].join('\n');

const table = (id: string, name: string, page: string, input: string) => ({ id, name, page, keys: [{ input, match: 'band' }], rows: [{ keys: [0], factor: '1.0000' }], unused: null, unknown: null });
/** A manual that rates base loss cost x (trip cost / 100) x 1 x 1, with a loss cost multiplier of 1. */
const manualDoc = (baseLossCost: string) => ({
  baseLossCost,
  exposure: { kind: 'per_100_trip_cost', table: 'exposure' },
  minimumTripCost: null,
  variables: [{ label: 'Age', tables: ['age'] }],
  perilPackage: null,
  exclusionWaivers: null,
  supplemental: [],
  tables: [table('exposure', 'Trip cost per $100', 'SYNTH-1', 'tripCost'), table('age', 'Age', 'SYNTH-2', 'age')],
  conversion: { lossCostMultiplier: '1.0000', minimumPremium: null, roundTo: 2 },
});

export interface Stack {
  t: TestContext;
  tokens: { product: string; compliance: string; analyst: string; analyst2: string; uw1: string; uw2: string; partner: string; partnerB: string; admin: string };
  accountId: string;
  accountBId: string;
  planCode: string;
  planId: string;
  planVersionId: string;
  ruleSetId: string;
  disclosureVersion: string;
  dates: { purchase: string; deposit: string; departure: string; return: string };
  /** One traveller with a 4200 trip: TCAN 84.00, TINT 42.00. */
  quoteBody: (over?: Record<string, unknown>) => Record<string, unknown>;
  scheduleTemplateId: string;
}

export async function publishedStack(t: TestContext): Promise<Stack> {
  const tokens = {
    product: await t.idp.token({ roles: ['product_manager'], sub: 'product-1', name: 'Pat Product' }),
    compliance: await t.idp.token({ roles: ['compliance_officer'], sub: 'compliance-1', name: 'Cora Compliance' }),
    analyst: await t.idp.token({ roles: ['rating_analyst'], sub: 'analyst-1', name: 'Ana Analyst' }),
    analyst2: await t.idp.token({ roles: ['rating_analyst'], sub: 'analyst-2', name: 'Alex Analyst' }),
    uw1: await t.idp.token({ roles: ['underwriter'], sub: 'uw-1', name: 'Uma Underwriter' }),
    uw2: await t.idp.token({ roles: ['underwriter'], sub: 'uw-2', name: 'Ulrich Underwriter' }),
    admin: await t.idp.token({ roles: ['platform_admin'], sub: 'admin-1', name: 'Alex Admin' }),
    partner: '',
    partnerB: '',
  };
  const stamp = Date.now().toString(36).toUpperCase();
  const accountId = await insertAccount(t.pool, `QUOTE-A-${stamp}`);
  const accountBId = await insertAccount(t.pool, `QUOTE-B-${stamp}`);
  tokens.partner = await t.idp.token({ roles: ['partner_developer'], accountId, sub: 'svc-quote-a' });
  tokens.partnerB = await t.idp.token({ roles: ['partner_developer'], accountId: accountBId, sub: 'svc-quote-b' });
  const s = (method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, token: string, payload?: unknown, headers?: Record<string, string>) => send(t, method, url, token, payload, headers);
  const ok = (r: { statusCode: number; body: string }, what: string, code = 200) => expect(r.statusCode, `${what}: ${r.body}`).toBeOneOf([code, 200, 201]);

  const dates = { purchase: today(), deposit: addDays(today(), -10), departure: addDays(today(), 20), return: addDays(today(), 29) };

  // ---- Reference data: states, and the Delaware disclosure.
  const loadRef = async (dataset: string, entries: unknown[], reuse = false) => {
    const v = await s('POST', `/v1/reference-data/${dataset}/versions`, tokens.analyst, { effectiveFrom: '2026-01-01', source: 'Synthetic test data', entries });
    // A development database may already hold the dataset in force; the states list is then reused.
    if (reuse && v.statusCode === 409) return '';
    ok(v, `load ${dataset}`, 201);
    ok(await s('POST', `/v1/reference-data/${dataset}/versions/${v.json().id}/decision`, tokens.compliance, { decision: 'approve', reason: 'Test data.' }), `approve ${dataset}`);
    return v.json().id as string;
  };
  await loadRef('us_states', [{ code: 'DE', name: 'Delaware', kind: 'state' }], true);
  const disclosureVersion = await loadRef('state_disclosures', [{ state: 'DE', title: 'Delaware disclosure (synthetic)', text: 'This synthetic disclosure stands in for the notice Delaware requires before cover is bound.' }]);

  // ---- An approved sanctions list (loaded by compliance, approved by an underwriter).
  const list = await s('POST', '/v1/sanctions-lists', tokens.compliance, { source: 'Synthetic list', sdnCsv: '9001,"TESTBURG, Zorbek Quill",individual,SYNTH,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 12 Mar 1970"' });
  ok(list, 'load sanctions list', 201);
  ok(await s('POST', `/v1/sanctions-lists/${list.json().id}/decision`, tokens.uw1, { decision: 'approve', reason: 'Matches the file.' }), 'approve sanctions list');

  // ---- The filed schedule, its variable map and the benefit catalogue.
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/form-editions?formNumber=q_sch&edition=2026-04&title=Synthetic%20schedule&kind=schedule&insurer=VSC&fileName=s.txt',
    headers: { ...bearer(tokens.compliance), 'content-type': 'text/plain' },
    payload: Buffer.from(SCHEDULE),
  });
  ok(res, 'load schedule', 201);
  const ed = res.json().id as string;
  const map = (await s('POST', `/v1/form-editions/${ed}/maps`, tokens.product)).json().id as string;
  const spans = (await s('GET', `/v1/form-editions/${ed}/brackets`, tokens.product)).json().items as { start: number; end: number; text: string; suggestion: { type: string; constraints: Record<string, unknown> } | null }[];
  const keys: Record<string, string> = { '[$500-$10,000]': 'tc_max', '[$500-$15,000]': 'ti_max', '[$100-$2,000]': 'delay_max', '[ten (10) - twenty (20)]': 'ts_period', '[ten (10) - fifteen (15)]': 'review' };
  for (const sp of spans) {
    const key = keys[sp.text];
    if (!key) continue;
    ok(await s('PUT', `/v1/variable-maps/${map}/variables/${key}`, tokens.product, { key, label: key, type: sp.suggestion!.type, constraints: sp.suggestion!.constraints, textStart: sp.start, textEnd: sp.end, excerpt: sp.text }), `map ${key}`);
  }
  ok(await s('POST', `/v1/variable-maps/${map}/approve`, tokens.compliance, { note: 'Checked against the test schedule.' }), 'approve map');
  const cat = (await s('POST', `/v1/form-editions/${ed}/catalogues`, tokens.product, {})).json().id as string;
  const sv = (key: string) => ({ source: 'schedule', key });
  for (const [code, name, group, key] of [['trip_cancellation', 'Trip Cancellation', 'pre_departure', 'tc_max'], ['trip_interruption', 'Trip Interruption', 'post_departure', 'ti_max'], ['trip_delay', 'Trip Delay', 'post_departure', 'delay_max']] as const) {
    ok(await s('PUT', `/v1/benefit-catalogues/${cat}/benefits/${code}`, tokens.product, { code, name, group, maximum: { variable: sv(key), basis: { kind: 'fixed', basis: 'per_person' } } }), `benefit ${code}`);
  }
  ok(await s('PUT', `/v1/benefit-catalogues/${cat}/covered-reasons/sickness`, tokens.product, { code: 'sickness', text: 'Sickness (synthetic wording)', category: 'Medical and Health', appliesTo: ['trip_cancellation', 'trip_interruption'], coverageLevels: ['self'], perilNumber: '1' }), 'reason');
  ok(await s('POST', `/v1/benefit-catalogues/${cat}/approve`, tokens.compliance, { note: 'Matches the test schedule.' }), 'approve catalogue');

  // ---- The base plan (approved) and the state plan.
  const base = await s('POST', '/v1/plans', tokens.product, { kind: 'base', code: 'Q-BASE', name: 'Quote base plan', term: 'single_trip', catalogueId: cat, effectiveFrom: '2026-01-01' });
  ok(base, 'create base plan', 201);
  const st = (setting: string, key: string, value: number) => ({ setting, variable: sv(key), value });
  const doc = {
    benefits: [
      { code: 'trip_cancellation', packaging: 'packaged', ratingBenefit: 'TCAN', underwriter: 'VSC' },
      { code: 'trip_interruption', packaging: 'standalone_optional', ratingBenefit: 'TINT', underwriter: 'ABIC' },
      { code: 'trip_delay', packaging: 'standalone_optional', ratingBenefit: null, underwriter: 'VSC' },
    ],
    coveredReasons: [{ code: 'sickness', levels: ['self'] }],
    values: { 'schedule:tc_max': 5000, 'schedule:ti_max': 7500, 'schedule:delay_max': 1000 },
    settings: [st('time_sensitive_period', 'ts_period', 20), st('review_period', 'review', 10)],
    timing: {
      pre_departure: { start: { kind: 'day_after_premium_received' }, end: { kind: 'return_date' } },
      post_departure: { start: { kind: 'departure' }, end: { kind: 'return_date' } },
    },
  };
  ok(await s('PUT', `/v1/plan-versions/${base.json().draft.id}`, tokens.product, { document: doc }), 'save base plan');
  ok(await s('POST', `/v1/plan-versions/${base.json().draft.id}/approve`, tokens.compliance, { note: 'Base plan checked.' }), 'approve base plan');
  const state = await s('POST', '/v1/plans', tokens.product, { kind: 'state', code: 'Q-DE', name: 'Quote plan, Delaware', parentPlanId: base.json().plan.id, state: 'DE', effectiveFrom: '2026-01-01' });
  ok(state, 'create state plan', 201);
  const planId = state.json().plan.id as string;
  const planVersionId = state.json().draft.id as string;
  ok(await s('POST', `/v1/plan-versions/${planVersionId}/approve`, tokens.compliance, { note: 'State plan checked.' }), 'approve state plan');

  // ---- Filings, two published manuals, plan test cases, and publication.
  const file = async (item: Record<string, unknown>) => {
    const f = (await s('POST', '/v1/filings', tokens.compliance, { states: ['DE'], insurer: 'VSC', ...item })).json().items[0];
    await s('POST', `/v1/filings/${f.id}/status`, tokens.compliance, { status: 'submitted', on: '2025-10-01', reason: 'Filed.' });
    ok(await s('POST', `/v1/filings/${f.id}/status`, tokens.compliance, { status: 'approved', on: '2025-12-01', effectiveFrom: '2026-01-01', reason: 'Approved.' }), 'approve filing');
  };
  await file({ itemType: 'form_edition', itemId: ed });
  for (const [code, benefit, base] of [['Q-TCAN-DE', 'TCAN', '2.000'], ['Q-TINT-DE', 'TINT', '1.000']] as const) {
    const m = await s('POST', '/v1/rate-manuals', tokens.analyst, { code, state: 'DE', benefit, effectiveFrom: '2026-01-01', source: 'SYNTHETIC test manual (not a filed manual)', document: manualDoc(base) });
    ok(m, `load ${code}`, 201);
    const id = m.json().id as string;
    ok(await s('POST', `/v1/rate-manuals/${id}/approve`, tokens.analyst2, { note: 'Tables checked against the test pages.' }), `approve ${code}`);
    const csv = ['name,expected_amount,age,cost_per_traveller,purchase_date,departure_date,return_date,package_type', `Synthetic case,${benefit === 'TCAN' ? '84.00' : '42.00'},45,4200,2026-11-21,2026-12-11,2026-12-20,packaged`].join('\n');
    ok(await s('POST', `/v1/rate-manuals/${id}/parity-cases?source=Synthetic%20workbook&rateDate=2026-11-01`, tokens.analyst, csv, { 'content-type': 'text/csv' }), `parity cases ${code}`, 201);
    const run = (await s('POST', `/v1/rate-manuals/${id}/parity-runs`, tokens.analyst)).json();
    expect(run, `parity ${code}`).toMatchObject({ total: 1, passed: 1 });
    await file({ itemType: 'rate_manual', itemReference: code });
    ok(await s('POST', `/v1/rate-manuals/${id}/publish`, tokens.analyst2), `publish ${code}`);
  }
  const tc = (await s('POST', `/v1/plans/${planId}/test-cases`, tokens.product, {
    name: 'One traveller, 4200',
    input: { rateDate: dates.purchase, travellers: [{ id: 'A', age: 45, costPerTraveller: '4200' }], trip: { purchaseDate: dates.purchase, departureDate: dates.departure, returnDate: dates.return, destinations: [] }, account: { notCollected: [] } },
    expected: { perBenefit: { TCAN: '84.00', TINT: '42.00' }, policyTotal: '126.00' },
  }));
  ok(tc, 'plan test case', 201);
  expect((await s('POST', `/v1/plan-versions/${planVersionId}/test-runs`, tokens.product)).json(), 'plan tests').toMatchObject({ total: 1, passed: 1 });
  ok(await s('POST', `/v1/plan-versions/${planVersionId}/publish`, tokens.compliance), 'publish plan');

  // ---- The rule set, with test cases, approved by a second underwriter and published.
  const rs = await s('POST', `/v1/plans/${planId}/rule-sets`, tokens.uw1, { effectiveFrom: '2026-01-01' });
  ok(rs, 'start rule set', 201);
  const ruleSetId = rs.json().id as string;
  ok(await s('PUT', `/v1/rule-sets/${ruleSetId}`, tokens.uw1, { document: { limits: [{ code: 'max_age', kind: 'max_age', value: 75 }], referralRules: [{ code: 'high_cost', name: 'High trip cost', when: { field: 'cost_per_traveller', op: 'gt', value: 8000 }, action: 'refer', reason: 'Trip cost is unusually high for this plan.' }], timeBasedBenefits: [{ benefit: 'trip_delay' }], duplicates: { enabled: true, allowSingleAndAnnual: false } } }), 'save rule set');
  const evalInput = (age: number, cost: string) => ({ stage: 'quote', travellers: [{ id: 'A', firstName: 'Pat', lastName: 'Sample', dateOfBirth: '1980-05-05', age, costPerTraveller: cost }], trip: { purchaseDate: dates.purchase, initialDepositDate: dates.deposit, departureDate: dates.departure, returnDate: dates.return, destinations: [{ country: 'FR', region: 'Europe' }] }, insuredPercent: 100, ableToTravel: true });
  for (const c of [
    { name: 'Typical adult', input: evalInput(45, '4200'), expected: { outcome: 'eligible', waiver: true } },
    { name: 'Too old', input: evalInput(80, '4200'), expected: { outcome: 'ineligible' } },
    { name: 'High cost', input: evalInput(45, '9000'), expected: { outcome: 'referred', referralRules: ['high_cost'] } },
  ]) ok(await s('POST', `/v1/plans/${planId}/rule-test-cases`, tokens.uw1, c), `rule test ${c.name}`, 201);
  ok(await s('POST', `/v1/rule-sets/${ruleSetId}/approve`, tokens.uw2, { note: 'Limits and rule checked.' }), 'approve rule set');
  expect((await s('POST', `/v1/rule-sets/${ruleSetId}/test-runs`, tokens.uw1)).json(), 'rule tests').toMatchObject({ total: 3, passed: 3 });
  ok(await s('POST', `/v1/rule-sets/${ruleSetId}/publish`, tokens.uw2), 'publish rule set');

  // ---- The schedule assembled from the filed form, released by a second person (E09-F01-S01, E09-F02-S01).
  const tpl = await s('POST', '/v1/document-templates', tokens.product, { planVersionId, kind: 'schedule' });
  ok(tpl, 'assemble schedule', 201);
  expect(tpl.json().problems, 'schedule assembly').toEqual([]);
  ok(await s('POST', `/v1/document-templates/${tpl.json().id}/release`, tokens.compliance, { note: 'Checked against the filed schedule.' }), 'release schedule');

  const quoteBody = (over: Record<string, unknown> = {}) => ({
    accountId,
    planCode: 'Q-DE',
    state: 'DE',
    travellers: [{ firstName: 'Pat', lastName: 'Sample', dateOfBirth: '1980-05-05', costPerTraveller: '4200' }],
    trip: { purchaseDate: dates.purchase, initialDepositDate: dates.deposit, departureDate: dates.departure, returnDate: dates.return, destinations: [{ country: 'FR', region: 'Europe' }] },
    ...over,
  });
  return { t, tokens, accountId, accountBId, planCode: 'Q-DE', planId, planVersionId, ruleSetId, disclosureVersion, dates, quoteBody, scheduleTemplateId: tpl.json().id as string };
}
