import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  ManualDocumentSchema,
  type ManualDocument,
  type RatingRequest,
  type RatingTable,
} from '@astra/contracts';
import {
  deriveInputs,
  lookup,
  rate,
  RatingError,
  type ManualForRating,
  type RatingValues,
} from './engine';
import { SPEC_ILLUSTRATIVE_REQUEST, SPEC_QUOTED_DE_TCAN } from './fixtures';

const manual = (doc: ManualDocument = SPEC_QUOTED_DE_TCAN): ManualForRating => ({
  id: '00000000-0000-4000-8000-000000000001',
  code: 'RETR-SP-VU-DE-0426',
  version: 1,
  benefit: 'TCAN',
  state: 'DE',
  illustrative: false,
  document: ManualDocumentSchema.parse(doc),
});
const req = (over: Partial<RatingRequest> = {}): RatingRequest =>
  structuredClone({ ...SPEC_ILLUSTRATIVE_REQUEST, ...over });
/** The illustrative request plus one covered reason, for manuals with a peril package. */
const covered = (over: Partial<RatingRequest> = {}): RatingRequest => {
  const r = req(over);
  if (!r.plan.perils.length) r.plan.perils = [{ peril: 'DEATH', levels: ['self'] }];
  return r;
};
const step = (r: ReturnType<typeof rate>, id: string) => r.steps.find((s) => s.step === id);

describe('the specification’s illustrative lookup (M2)', () => {
  // The specification's lookup leaves out the peril package ("to be confirmed with Assurant's actuaries").
  const lookupOnly = { ...SPEC_QUOTED_DE_TCAN, perilPackage: null };
  const r = rate(manual(lookupOnly), req());

  it('finds each factor the specification lists, with its band', () => {
    expect(step(r, 'table.2.1.5')).toMatchObject({ value: '1', band: 'from 4001' });
    expect(step(r, 'formula.tripCostFactor')!.value).toBe('42');
    expect(step(r, 'table.2.1.4')).toMatchObject({ value: '0.72', band: 'from 45, true' });
    expect(step(r, 'table.2.1.7')!.value).toBe('1.288');
    expect(step(r, 'table.2.1.8')).toMatchObject({ value: '0.768', band: 'from 15' });
    expect(step(r, 'table.2.1.9')!.value).toBe('1');
    expect(step(r, 'table.2.1.10')!.value).toBe('1.6286');
    expect(step(r, 'table.2.1.11')!.value).toBe('1.3333');
    expect(step(r, 'table.2.1.13')).toMatchObject({ value: '1.28', band: 'from 60' });
  });

  it('multiplies them exactly and labels the result a loss cost (no multiplier filed)', () => {
    const product = ['0.72', '1.288', '0.768', '1', '1.6286', '1.3333', '1.28'].reduce(
      (a, f) => a.mul(f),
      new Decimal(1),
    );
    expect(r.amount).toBe(
      new Decimal('1.475').mul(42).mul(product).toFixed(2, Decimal.ROUND_HALF_UP),
    );
    expect(r.kind).toBe('loss_cost');
    expect(step(r, 'formula.lossCostMultiplier')!.note).toContain('result is a loss cost');
  });

  it('is deterministic', () => {
    const again = rate(manual(lookupOnly), req());
    expect(again).toEqual(r);
  });
});

describe('table lookups (E02-F02)', () => {
  const values = (v: Partial<RatingValues>) => ({ ...deriveInputs(req()), ...v }) as RatingValues;
  const t = (id: string) => SPEC_QUOTED_DE_TCAN.tables.find((x) => x.id === id)! as RatingTable;

  it('matches the highest lower bound, tested at the bound and one unit below', () => {
    expect(lookup(t('2.1.5'), values({ tripCost: '4200' }), []).band).toBe('from 4001');
    expect(lookup(t('2.1.5'), values({ tripCost: '4001' }), []).band).toBe('from 4001');
    expect(() => lookup(t('2.1.5'), values({ tripCost: '4000' }), [])).toThrow(
      /below the lowest band/,
    );
    expect(lookup(t('2.1.8'), values({ daysBeforeDeparture: 20 }), []).factor.toString()).toBe(
      '0.768',
    );
    expect(lookup(t('2.1.8'), values({ daysBeforeDeparture: 15 }), []).band).toBe('from 15');
    expect(() => lookup(t('2.1.8'), values({ daysBeforeDeparture: 14 }), [])).toThrow(RatingError);
    expect(lookup(t('2.1.8'), values({ daysBeforeDeparture: 900 }), []).factor.toString()).toBe(
      '1.294',
    );
  });

  it('uses two keys: age 45 with the exclusion waived or not', () => {
    expect(
      lookup(t('2.1.4'), values({ age: 45, preExistingWaived: true }), []).factor.toString(),
    ).toBe('0.72');
    expect(
      lookup(t('2.1.4'), values({ age: 45, preExistingWaived: false }), []).factor.toString(),
    ).toBe('0.6');
  });

  // Synthetic table: the specification gives no unused or unknown factor values.
  const synthetic: RatingTable = {
    id: 'X.1',
    name: 'Synthetic',
    page: 'test',
    keys: [{ input: 'lookbackDays', match: 'exact' }],
    rows: [{ keys: [60], factor: '1.1' }],
    unused: '1.05',
    unknown: '1.2',
  };

  it('uses the unused factor only when the account does not collect the variable, and says why', () => {
    const l = lookup(synthetic, values({ lookbackDays: null }), ['lookbackDays']);
    expect(l).toMatchObject({ how: 'unused', why: expect.stringContaining('does not collect') });
    expect(l.factor.toString()).toBe('1.05');
    expect(lookup(synthetic, values({ lookbackDays: null }), []).how).toBe('unknown');
    expect(lookup(synthetic, values({ lookbackDays: 90 }), []).how).toBe('unknown');
    expect(() =>
      lookup({ ...synthetic, unknown: null }, values({ lookbackDays: null }), []),
    ).toThrow(/is not given/);
    expect(() => lookup({ ...synthetic, unused: null }, values({}), ['lookbackDays'])).toThrow(
      /no unused factor/,
    );
  });
});

describe('special rules and derived inputs (E02-F02-S04, E02-F04-S02, E02-F04-S03)', () => {
  // Synthetic $1 band: the specification quotes the rule but not the $1 band's factor.
  const withLowBand = structuredClone(SPEC_QUOTED_DE_TCAN);
  withLowBand.tables[0]!.rows.unshift({ keys: [1], factor: '1.5000' });

  it('rates trip costs from $1 to $500 as $500, and refuses $0 until the rule is confirmed', () => {
    for (const cost of ['1', '250', '500']) {
      const r = rate(
        manual(withLowBand),
        covered({ trip: { ...req().trip, costPerTraveller: cost } }),
      );
      expect(step(r, 'rule.minimumTripCost')!.value).toBe('500');
      expect(step(r, 'formula.tripCostFactor')!.value).toBe('7.5');
    }
    expect(() =>
      rate(manual(withLowBand), covered({ trip: { ...req().trip, costPerTraveller: '0' } })),
    ).toThrow(/confirmed with Assurant/);
  });

  it('derives trip length, days before departure, waiver period, per-person cost and primary destination', () => {
    const v = deriveInputs(
      req({
        trip: {
          reservationTotal: '9000',
          travellers: 3,
          purchaseDate: '2026-03-01',
          initialDepositDate: '2026-02-20',
          departureDate: '2026-04-10',
          returnDate: '2026-04-24',
          destinations: [
            { region: 'Caribbean', days: 4 },
            { region: 'Europe', days: 11 },
          ],
        },
      }),
    );
    expect(v).toMatchObject({
      tripCost: '3000',
      tripLength: 15,
      daysBeforeDeparture: 40,
      waiverPeriodDays: 9,
      departureMonth: 4,
      destinationRegion: 'Europe',
    });
    expect(() => deriveInputs(req({ trip: { ...req().trip, returnDate: '2026-12-01' } }))).toThrow(
      /before the departure/,
    );
  });
});

describe('peril package, waivers and supplemental benefits (E02-F03-S03..S05)', () => {
  it('refuses a plan that covers no reasons', () => {
    expect(() => rate(manual(), req())).toThrow(/covers no reasons/);
  });

  it('sums the peril percentages for each covered reason and coverage level, and lists each', () => {
    const r = rate(
      manual(),
      req({
        plan: {
          ...req().plan,
          perils: [{ peril: 'DEATH', levels: ['self', 'family_member', 'travelling_companion'] }],
        },
      }),
    );
    expect(step(r, 'formula.perilPackage')).toMatchObject({
      value: '0.06717',
      note: 'Sum of 6.717% over the covered reasons',
    });
    expect(r.steps.filter((s) => s.step.startsWith('peril.')).map((s) => s.value)).toEqual([
      '3.610%',
      '2.704%',
      '0.403%',
    ]);
  });

  it('caps combined exclusion waivers at the filed maximum (synthetic waiver factors)', () => {
    const doc = structuredClone(SPEC_QUOTED_DE_TCAN);
    doc.tables.push({
      id: 'W',
      name: 'Removal of exclusions (synthetic factors)',
      page: 'test',
      keys: [{ input: 'exclusion', match: 'exact' }],
      rows: [
        { keys: ['A'], factor: '1.08' },
        { keys: ['B'], factor: '1.06' },
      ],
      unused: null,
      unknown: null,
    });
    doc.exclusionWaivers = { table: 'W', maxCombined: '1.1220' };
    const one = rate(manual(doc), covered({ plan: { ...req().plan, waivedExclusions: ['A'] } }));
    expect(step(one, 'formula.waivers')!.value).toBe('1.08');
    const both = rate(
      manual(doc),
      covered({ plan: { ...req().plan, waivedExclusions: ['A', 'B'] } }),
    );
    expect(step(both, 'formula.waivers')).toMatchObject({
      value: '1.122',
      note: expect.stringContaining('capped at the filed maximum 1.122'),
    });
  });

  it('rates supplemental benefits per $100 below $1,000 and flat at $1,000 or more', () => {
    const add = (amount: string) =>
      step(
        rate(
          manual(),
          covered({ plan: { ...req().plan, supplemental: [{ code: 'supplemental', amount }] } }),
        ),
        'supplemental.supplemental',
      )!.value;
    expect(add('999')).toBe('0.01998');
    expect(add('1000')).toBe('0.02');
    expect(add('5000')).toBe('0.02');
  });

  it('applies a loss cost multiplier, rounding and minimum premium when filed (synthetic values)', () => {
    const doc = structuredClone(SPEC_QUOTED_DE_TCAN);
    doc.conversion = { lossCostMultiplier: '1.5', minimumPremium: '500', roundTo: 2 };
    const r = rate(manual(doc), covered());
    expect(r.kind).toBe('premium');
    expect(step(r, 'formula.minimumPremium')!.value).toBe('500.00');
    expect(r.amount).toBe('500.00');
  });
});
