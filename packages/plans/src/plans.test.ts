import { describe, expect, it } from 'vitest';
import { CatalogueDocumentSchema, PlanDocumentSchema, type PlanDocument } from '@astra/contracts';
import { diffPlans, planToQuote, requiredValues, validatePlan, type PlanVariables } from './plans';

/** Synthetic catalogue and variable map: names follow the specification; ranges are invented for the test. */
const s = (key: string) => ({ source: 'schedule' as const, key });
const p = (key: string) => ({ source: 'policy' as const, key });
const cat = CatalogueDocumentSchema.parse({
  benefits: [
    {
      code: 'trip_cancellation',
      name: 'Trip Cancellation',
      group: 'pre_departure',
      maximum: { variable: s('tc_max'), basis: { kind: 'variable', variable: s('tc_basis') } },
      subLimits: [{ code: 'tuition', name: 'Tuition', amount: { variable: s('tc_tuition'), basis: { kind: 'fixed', basis: 'per_person' } }, includedInParent: true, optional: s('tuition_on') }],
    },
    { code: 'medical', name: 'Medical Expense', group: 'medical_evacuation', maximum: { variable: s('med_max'), basis: { kind: 'fixed', basis: 'per_person' } } },
  ],
  coveredReasons: [
    { code: 'sickness', text: 'Sickness', category: 'Medical and Health', appliesTo: ['trip_cancellation', 'trip_interruption'], coverageLevels: ['self', 'family_member'], perilNumber: '1' },
    { code: 'job_loss', text: 'Job loss', category: 'Employment and Service', appliesTo: ['trip_cancellation'], coverageLevels: ['self'], perilNumber: '27', upgrade: 'employment' },
  ],
  upgrades: [{ code: 'employment', name: 'Employment reasons', kind: 'covered_reason_set', offeredBy: s('employment_on') }],
});
const vars: PlanVariables = new Map([
  ['schedule:tc_max', { label: 'Trip Cancellation maximum', type: 'numeric_range', constraints: { min: 0, max: 5_000_000, unit: 'usd' } }],
  ['schedule:tc_basis', { label: 'TC basis', type: 'limit_basis', constraints: { options: ['PER PERSON', 'PER TRIP'] } }],
  ['schedule:tc_tuition', { label: 'Tuition', type: 'numeric_range', constraints: { min: 0, max: 10_000, unit: 'usd' } }],
  ['schedule:tuition_on', { label: 'Tuition included', type: 'optional_benefit', constraints: {} }],
  ['schedule:med_max', { label: 'Medical maximum', type: 'numeric_range', constraints: { min: 10_000, max: 500_000, unit: 'usd' } }],
  ['schedule:employment_on', { label: 'Employment reasons', type: 'optional_benefit', constraints: {} }],
  ['policy:review', { label: 'Review period', type: 'time_period', constraints: { min: 10, max: 15, unit: 'days' } }],
  ['policy:lookback', { label: 'Lookback period', type: 'time_period', constraints: { min: 30, max: 180, unit: 'days' } }],
]);

const plan = (over: Partial<PlanDocument> = {}): PlanDocument =>
  PlanDocumentSchema.parse({
    benefits: [{ code: 'trip_cancellation', packaging: 'packaged', ratingBenefit: 'TCAN' }],
    coveredReasons: [{ code: 'sickness', levels: ['self', 'family_member'] }],
    values: { 'schedule:tc_max': 10_000, 'schedule:tc_basis': 'PER PERSON', 'schedule:tuition_on': false },
    settings: [
      { setting: 'review_period', variable: p('review'), value: 10 },
      { setting: 'lookback_period', variable: p('lookback'), value: 60 },
    ],
    ...over,
  });

describe('plan checks (E01-F03)', () => {
  it('accepts a consistent plan', () => {
    expect(validatePlan(plan(), cat, vars)).toEqual([]);
  });

  it('refuses values outside the filed range, showing the range', () => {
    const problems = validatePlan(plan({ values: { ...plan().values, 'schedule:tc_max': 6_000_000 } }), cat, vars);
    expect(problems).toEqual([{ path: 'values.schedule:tc_max', message: 'Trip Cancellation maximum must be between 0 and 5000000 (filed range).' }]);
    const review = validatePlan(plan({ settings: [{ setting: 'review_period', variable: p('review'), value: 16 }] }), cat, vars);
    expect(review[0]!.message).toBe('Review period must be between 10 days and 15 days (filed range).');
    const lookback = validatePlan(plan({ settings: [{ setting: 'lookback_period', variable: p('lookback'), value: 29 }] }), cat, vars);
    expect(lookback[0]!.message).toContain('between 30 days and 180 days');
  });

  it('allows only the filed wording', () => {
    const problems = validatePlan(plan({ values: { ...plan().values, 'schedule:tc_basis': 'PER HOUSEHOLD' } }), cat, vars);
    expect(problems[0]!.message).toBe('TC basis must be one of: PER PERSON, PER TRIP.');
  });

  it('requires a value for every amount of an included benefit, unless an optional sub-limit is off', () => {
    expect(requiredValues(plan(), cat)).toEqual(['schedule:tc_basis', 'schedule:tc_max']);
    expect(requiredValues(plan({ values: { ...plan().values, 'schedule:tuition_on': true } }), cat)).toContain('schedule:tc_tuition');
    const missing = validatePlan(plan({ benefits: [...plan().benefits, { code: 'medical', packaging: 'standalone_optional', ratingBenefit: null }] }), cat, vars);
    expect(missing).toEqual([{ path: 'values.schedule:med_max', message: 'Medical maximum needs a value.' }]);
  });

  it('checks covered reasons against the catalogue and their upgrades', () => {
    const problems = validatePlan(plan({ coveredReasons: [{ code: 'sickness', levels: ['travelling_companion'] }, { code: 'job_loss', levels: ['self'] }] }), cat, vars);
    expect(problems.map((x) => x.message)).toEqual([
      'Sickness: the form does not cover travelling companion.',
      'Job loss comes with the employment upgrade, which the plan does not offer.',
    ]);
  });

  it('lets account plans change only open values, within the base plan bounds (E01-F03-S04)', () => {
    const base = { kind: 'base' as const, document: plan({ bounds: { 'schedule:tc_max': { min: 5_000, max: 20_000 } } }) };
    expect(validatePlan(plan({ values: { ...plan().values, 'schedule:tc_max': 15_000 } }), cat, vars, base, 'account')).toEqual([]);
    const outside = validatePlan(plan({ values: { ...plan().values, 'schedule:tc_max': 25_000 } }), cat, vars, base, 'account');
    expect(outside[0]!.message).toBe('Trip Cancellation maximum must be between 5000 and 20000 for account plans.');
    const fixed = validatePlan(plan({ values: { ...plan().values, 'schedule:tc_basis': 'PER TRIP' } }), cat, vars, base, 'account');
    expect(fixed[0]!.message).toBe('TC basis is fixed by the base plan.');
    const structure = validatePlan(plan({ coveredReasons: [{ code: 'sickness', levels: ['self'] }] }), cat, vars, base, 'account');
    expect(structure[0]!.path).toBe('benefits');
  });
});

describe('rating requests from a plan', () => {
  it('takes package type, perils by coverage level and the lookback period from the plan', () => {
    const q = planToQuote(
      plan({ benefits: [{ code: 'trip_cancellation', packaging: 'standalone_optional', ratingBenefit: 'TCAN' }] }),
      cat,
      'DE',
      {
        rateDate: '2026-11-01',
        travellers: [{ id: 'A', age: 45 }],
        trip: { purchaseDate: '2026-11-21', departureDate: '2026-12-11', returnDate: '2026-12-20', destinations: [] },
        account: { notCollected: [] },
      },
    );
    expect(q.benefits).toEqual([
      {
        benefit: 'TCAN',
        plan: { packageType: 'optional', lookbackDays: 60, productType: null, perils: [{ peril: '1', levels: ['self', 'family_member'] }], waivedExclusions: [], supplemental: [] },
      },
    ]);
  });
});

describe('version comparison (E01-F04-S02)', () => {
  it('lists changed benefits, values, settings and links', () => {
    const a = { id: '00000000-0000-4000-8000-000000000001', version: 1, document: plan(), links: { schedule: 'sch ed. 2026-04', TCAN: 'MANUAL v1' }, effectiveFrom: '2026-01-01' };
    const b = {
      ...a,
      id: '00000000-0000-4000-8000-000000000002',
      version: 2,
      document: plan({
        benefits: [{ code: 'trip_cancellation', packaging: 'standalone_optional', ratingBenefit: 'TCAN' }],
        values: { ...plan().values, 'schedule:tc_max': 20_000 },
        settings: [{ setting: 'review_period', variable: p('review'), value: 14 }],
      }),
      links: { schedule: 'sch ed. 2026-04', TCAN: 'MANUAL v2' },
    };
    const d = diffPlans(a, b);
    expect(d.changes.map((c) => `${c.area}:${c.item}:${c.change}`)).toEqual([
      'benefit:trip_cancellation:changed',
      'value:schedule:tc_max:changed',
      'setting:review_period:changed',
      'setting:lookback_period:removed',
      'link:TCAN:changed',
    ]);
  });
});
