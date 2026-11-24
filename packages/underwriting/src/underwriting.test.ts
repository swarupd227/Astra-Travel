import { describe, expect, it } from 'vitest';
import { EvaluationInputSchema, RuleSetDocumentSchema, type EvaluationInput, type RuleSetDocument } from '@astra/contracts';
import { evaluate, type EvaluationData } from './evaluate';
import { findDuplicates } from './duplicates';
import { checkRuleSet, evaluateCondition } from './rules';
import { parseBirths, parseSdn, Screener } from './sanctions';

/**
 * All names, amounts and limits here are invented for the tests. The sanctions entries are fictional and
 * follow only the published SDN.CSV layout (12 headerless columns, "-0-" for empty values).
 */
const SDN = [
  '9001,"TESTBURG, Zorbek Quill",individual,SYNTH-PROGRAM,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 12 Mar 1970; alt. DOB 1971; POB Nowhere"',
  '9002,"ACME SYNTHETIC TRADING LLC",-0-,SYNTH-PROGRAM,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-',
  '9003,"MÜLLER-TESTOVA, Ana",individual,SYNTH-PROGRAM,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-',
].join('\r\n');
const ALT = '9001,1,aka,"Z. Testburg",-0-\r\n9003,2,aka,"Anna Mueller Testova",-0-';

const doc = (over: Partial<RuleSetDocument> = {}): RuleSetDocument => RuleSetDocumentSchema.parse({ ...over });

const base = (over: Record<string, unknown> = {}): EvaluationInput =>
  EvaluationInputSchema.parse({
    stage: 'bind',
    travellers: [{ id: 'A', firstName: 'Pat', lastName: 'Sample', dateOfBirth: '1980-05-05', age: 45, costPerTraveller: '4200' }],
    trip: {
      purchaseDate: '2026-11-21',
      initialDepositDate: '2026-11-10',
      departureDate: '2026-12-11',
      returnDate: '2026-12-20',
      destinations: [{ country: 'FR', region: 'Europe' }],
    },
    insuredPercent: 100,
    ableToTravel: true,
    ...over,
  });

const data = (over: Partial<EvaluationData> = {}, ruleSet: Partial<RuleSetDocument> = {}): EvaluationData => ({
  planVersionId: '00000000-0000-4000-8000-000000000001',
  ruleSet: { id: '00000000-0000-4000-8000-000000000002', version: 3, document: doc(ruleSet) },
  plan: { timeSensitiveDays: 20, lookbackDays: 60, cfarTripCostCap: 10_000, cfarNoticePeriod: { value: 14, unit: 'days' } },
  preview: false,
  prohibited: new Map([['KP', 'Filed exclusion (synthetic)']]),
  sanctions: { version: 'synthetic list', screener: new Screener(parseSdn(SDN, ALT).entries) },
  covers: [],
  registerRows: 0,
  ...over,
});

describe('plan limits (E03-F01-S02)', () => {
  const limits = [
    { code: 'max_age', kind: 'max_age', value: 70 },
    { code: 'max_days', kind: 'max_trip_days', value: 30 },
    { code: 'max_cost', kind: 'max_trip_cost', value: 5000 },
  ] as const;

  it('is eligible inside every limit', () => {
    const r = evaluate(base(), data({}, { limits: [...limits] }));
    expect(r.outcome).toBe('eligible');
    expect(r.checks.filter((c) => c.area === 'limit').every((c) => c.passed)).toBe(true);
  });

  it('says which limit a quote is outside and by how much', () => {
    const r = evaluate(base({ travellers: [{ id: 'A', firstName: 'Pat', lastName: 'Sample', age: 72, costPerTraveller: '6000.50' }] }), data({}, { limits: [...limits] }));
    expect(r.outcome).toBe('ineligible');
    expect(r.reasons).toEqual([
      'Maximum age for this plan is 70 years; this traveller is 72.',
      'Maximum trip cost for this plan is $5,000.00; this trip costs $6,000.50.',
    ]);
  });

  it('takes age from the date of birth when no age is given', () => {
    const r = evaluate(base({ travellers: [{ id: 'A', firstName: 'Pat', lastName: 'Sample', dateOfBirth: '1950-12-01', costPerTraveller: '100' }] }), data({}, { limits: [{ code: 'max_age', kind: 'max_age', value: 70 }] }));
    expect(r.reasons[0]).toContain('this traveller is 75');
  });

  it('flags inconsistent limits', () => {
    expect(checkRuleSet(doc({ limits: [{ code: 'lo', kind: 'min_age', value: 80 }, { code: 'hi', kind: 'max_age', value: 70 }] }))).toEqual([
      { path: 'limits.hi', message: 'Minimum age is above maximum age.' },
    ]);
  });
});

describe('pre-existing waiver and CFAR (E03-F02, E03-F03)', () => {
  it('applies the waiver only when all three filed conditions pass, and says which failed', () => {
    expect(evaluate(base(), data()).waiver.applies).toBe(true);
    const late = evaluate(base({ trip: { ...base().trip, purchaseDate: '2026-12-05' } }), data());
    expect(late.waiver.applies).toBe(false);
    expect(late.waiver.conditions.find((c) => c.code === 'premium_in_period')!.detail).toBe('The premium is received 25 days after the initial deposit on 2026-11-10; the period is 20 days.');
    const partial = evaluate(base({ insuredPercent: 80 }), data());
    expect(partial.waiver.conditions.filter((c) => !c.passed).map((c) => c.code)).toEqual(['fully_insured']);
    expect(evaluate(base({ ableToTravel: null, stage: 'quote' }), data()).waiver.applies).toBe(false);
  });

  it('cannot show the time condition without the deposit date or the plan period', () => {
    const noDeposit = evaluate(base({ trip: { ...base().trip, initialDepositDate: undefined } }), data());
    expect(noDeposit.waiver.applies).toBe(false);
    expect(noDeposit.waiver.conditions[0]!.detail).toContain('deposit date is not given');
    const noPeriod = evaluate(base(), data({ plan: { timeSensitiveDays: null, lookbackDays: null, cfarTripCostCap: null, cfarNoticePeriod: null } }));
    expect(noPeriod.waiver.conditions[0]!.detail).toBe('The plan has no time-sensitive period set.');
  });

  it('offers CFAR only when its conditions pass, with the reasons and the stored notice period', () => {
    const ok = evaluate(base(), data());
    expect(ok.cfar).toMatchObject({ passed: true, offered: true, noticePeriod: 14, reasons: [] });
    expect(ok.cfar.reference).toBe('rule set 00000000-0000-4000-8000-000000000002 v3');
    const dear = evaluate(base({ travellers: [{ id: 'A', firstName: 'Pat', lastName: 'Sample', age: 45, costPerTraveller: '12000' }] }), data());
    expect(dear.cfar).toMatchObject({ offered: false });
    expect(dear.cfar.reasons).toEqual(['The trip costs $12,000.00; the CFAR cap is $10,000.00.']);
  });

  it('limits time-based benefits to purchase within the time-sensitive period', () => {
    const rs = { timeBasedBenefits: [{ benefit: 'lost_activity_day' }] };
    expect(evaluate(base({ benefits: ['lost_activity_day', 'medical'] }), data({}, rs)).benefitAvailability).toEqual([
      { benefit: 'lost_activity_day', available: true, reason: 'Bought within the time-sensitive period.' },
      { benefit: 'medical', available: true, reason: 'No time condition.' },
    ]);
    const late = evaluate(base({ trip: { ...base().trip, purchaseDate: '2026-12-05' } }), data({}, rs));
    expect(late.benefitAvailability[0]!.available).toBe(false);
  });
});

describe('declaration, prohibited destinations and duplicates (E03-F01-S01, E03-F04)', () => {
  it('needs the able-to-travel confirmation to bind, and refuses a "no" at any stage', () => {
    expect(evaluate(base({ ableToTravel: null }), data()).outcome).toBe('ineligible');
    expect(evaluate(base({ ableToTravel: null, stage: 'quote' }), data()).outcome).toBe('eligible');
    expect(evaluate(base({ ableToTravel: false, stage: 'quote' }), data()).reasons).toEqual(['The traveller is not able to travel, so cover cannot be issued.']);
    expect(evaluate(base({ ableToTravel: null }), data({}, { ableToTravelRequired: false })).outcome).toBe('eligible');
  });

  it('blocks prohibited destinations from the list in force', () => {
    const r = evaluate(base({ trip: { ...base().trip, destinations: [{ country: 'FR' }, { country: 'KP' }] } }), data());
    expect(r.outcome).toBe('ineligible');
    expect(r.reasons).toEqual(['Cover is not offered for travel to KP: Filed exclusion (synthetic).']);
    const none = evaluate(base(), data({ prohibited: null }));
    expect(none.checks.find((c) => c.area === 'prohibited_destination')).toMatchObject({ passed: false });
  });

  const cover = { firstName: 'Pat', lastName: 'Sample', dateOfBirth: '1980-05-05', policyRef: 'P-1', tripStart: '2026-12-15', tripEnd: '2026-12-30', term: 'single_trip' as const };

  it('allows one policy per trip, except one single-trip and one annual where the plan allows it', () => {
    const t = { id: 'A', firstName: 'pat', lastName: 'SAMPLE', dateOfBirth: '1980-05-05' };
    expect(findDuplicates(t, { start: '2026-12-11', end: '2026-12-20', term: 'single_trip' }, [cover], false)).toHaveLength(1);
    expect(findDuplicates(t, { start: '2026-12-11', end: '2026-12-20', term: 'annual' }, [cover], false)).toHaveLength(1);
    expect(findDuplicates(t, { start: '2026-12-11', end: '2026-12-20', term: 'annual' }, [cover], true)).toHaveLength(0);
    expect(findDuplicates(t, { start: '2026-12-11', end: '2026-12-20', term: 'single_trip' }, [cover], true)).toHaveLength(1);
    expect(findDuplicates(t, { start: '2027-01-02', end: '2027-01-09', term: 'single_trip' }, [cover], false)).toHaveLength(0);
    expect(findDuplicates({ ...t, dateOfBirth: '1981-05-05' }, { start: '2026-12-11', end: '2026-12-20', term: 'single_trip' }, [cover], false)).toHaveLength(0);
    expect(findDuplicates(t, { start: '2026-12-11', end: '2026-12-20', term: 'single_trip', policyRef: 'P-1' }, [cover], false)).toHaveLength(0);
  });

  it('refuses a duplicate at bind, but not at quote', () => {
    const r = evaluate(base(), data({ covers: [cover], registerRows: 1 }));
    expect(r.outcome).toBe('ineligible');
    expect(r.reasons[0]).toBe('The traveller is already covered by policy P-1 (2026-12-15 to 2026-12-30), so a second policy for these dates is not allowed.');
    expect(evaluate(base({ stage: 'quote' }), data({ covers: [cover] })).outcome).toBe('eligible');
  });
});

describe('referral rules (E03-F05-S01)', () => {
  const rs = {
    referralRules: [
      { code: 'older_long_trip', name: 'Older traveller on a long trip', when: { all: [{ field: 'traveller_age', op: 'gte', value: 65 }, { field: 'trip_days', op: 'gt', value: 7 }] }, action: 'refer', reason: 'Long trip for an older traveller.' },
      { code: 'high_value', name: 'High value', when: { field: 'cost_per_traveller', op: 'gt', value: 8000 }, action: 'recommend_decline', reason: 'Trip cost is unusually high.' },
      { code: 'segment', name: 'Segment', when: { any: [{ field: 'business_segment', op: 'in', value: ['OTA - Cruise', 'Tour operator'] }, { field: 'destination_region', op: 'eq', value: 'Antarctica' }] }, action: 'refer', reason: 'Segment needs a look.' },
    ],
  } as Partial<RuleSetDocument>;

  it('refers when a rule fires, with the reason, and never declines on its own', () => {
    const r = evaluate(base({ travellers: [{ id: 'A', firstName: 'Pat', lastName: 'Sample', age: 70, costPerTraveller: '9000' }] }), data({}, rs));
    expect(r.outcome).toBe('referred');
    expect(r.referrals).toEqual([
      { rule: 'older_long_trip', reason: 'Long trip for an older traveller.', recommendation: 'refer' },
      { rule: 'high_value', reason: 'Trip cost is unusually high.', recommendation: 'recommend_decline' },
    ]);
    expect(r.summary).toContain('Rule high_value (recommends decline): Trip cost is unusually high.');
  });

  it('matches list and multi-value fields', () => {
    expect(evaluate(base({ businessSegment: 'OTA - Cruise' }), data({}, rs)).referrals.map((x) => x.rule)).toEqual(['segment']);
    expect(evaluate(base({ trip: { ...base().trip, destinations: [{ country: 'AQ', region: 'Antarctica' }] } }), data({}, rs)).referrals.map((x) => x.rule)).toEqual(['segment']);
    expect(evaluate(base(), data({}, rs)).outcome).toBe('eligible');
  });

  it('evaluates not, any and missing fields', () => {
    expect(evaluateCondition({ not: { field: 'traveller_age', op: 'lt', value: 18 } }, { traveller_age: 30 })).toBe(true);
    expect(evaluateCondition({ field: 'business_segment', op: 'neq', value: 'x' }, {})).toBe(false);
    expect(evaluateCondition({ field: 'destination_country', op: 'not_in', value: ['KP', 'IR'] }, { destination_country: ['FR', 'DE'] })).toBe(true);
  });

  it('rejects comparisons that make no sense', () => {
    const problems = checkRuleSet(
      doc({ referralRules: [{ code: 'bad', name: 'Bad rule', when: { field: 'business_segment', op: 'gt', value: 'x' }, action: 'refer', reason: 'Never fires' }] }),
    );
    expect(problems[0]!.message).toContain('cannot be compared with');
  });
});

describe('sanctions screening (E03-F04-S01)', () => {
  it('reads the published SDN.CSV and ALT.CSV layout and keeps individuals only', () => {
    const p = parseSdn(SDN, ALT);
    expect(p.problems).toEqual([]);
    expect(p.entries.map((e) => e.uid)).toEqual(['9001', '9003']);
    expect(p.aliases).toBe(2);
    expect(p.entries[0]!.births).toEqual([{ year: 1970, month: 3, day: 12 }, { year: 1971 }]);
    expect(parseBirths('DOB circa 1960; DOB Jan 1962')).toEqual([{ year: 1960 }, { year: 1962, month: 1 }]);
  });

  it('reports malformed rows instead of loading them', () => {
    expect(parseSdn('abc,def').problems).toEqual(['SDN.CSV row 1 has 2 columns; the published file has 12.']);
  });

  const hold = (first: string, last: string, dob?: string) =>
    evaluate(base({ travellers: [{ id: 'A', firstName: first, lastName: last, dateOfBirth: dob, age: 50 }] }), data());

  it('holds the bind on a possible match, whatever the order, case, accents or alias', () => {
    for (const [f, l] of [['Zorbek', 'Testburg'], ['TESTBURG', 'zorbek quill'], ['Z.', 'Testburg'], ['Zorbec', 'Testburg'], ['Ana', 'Müller-Testova'], ['Anna', 'Mueller Testova']] as const) {
      const r = hold(f, l);
      expect(r.outcome, `${f} ${l}`).toBe('held');
    }
    const r = hold('Zorbek', 'Testburg', '1970-03-12');
    expect(r.screening.possibleMatches[0]).toMatchObject({ uid: '9001', score: 1 });
    expect(r.summary).toContain('Possible sanctions match');
  });

  it('uses the date of birth to lower or raise the score', () => {
    const agrees = hold('Zorbec', 'Testburg', '1970-03-12').screening.possibleMatches[0]!.score;
    const unknown = hold('Zorbec', 'Testburg').screening.possibleMatches[0]!.score;
    expect(agrees).toBeGreaterThan(unknown);
    expect(hold('Zorbek', 'Testburg', '1999-01-01').outcome).toBe('eligible');
  });

  it('does not hold unrelated names or entities', () => {
    expect(hold('Pat', 'Sample').outcome).toBe('eligible');
    expect(hold('Acme', 'Synthetic').outcome).toBe('eligible');
  });

  it('holds the bind when no list is loaded, and says so', () => {
    const r = evaluate(base(), data({ sanctions: null }));
    expect(r.outcome).toBe('held');
    expect(r.summary).toContain('No approved sanctions list');
    expect(evaluate(base({ stage: 'quote' }), data({ sanctions: null })).outcome).toBe('eligible');
  });

  it('screens a full-size list quickly', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `${100000 + i},"SURNAME${i.toString(36)}, Given${(i * 7).toString(36)}",individual,SYNTH,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-`).join('\n');
    const screener = new Screener(parseSdn(rows).entries);
    const t = performance.now();
    screener.screen([{ id: 'A', firstName: 'Pat', lastName: 'Sample' }, { id: 'B', firstName: 'Lee', lastName: 'Example' }], 0.9);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
