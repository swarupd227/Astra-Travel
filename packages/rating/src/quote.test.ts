import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  ManualDocumentSchema,
  type ManualDocument,
  type QuoteRatingRequest,
} from '@astra/contracts';
import type { ManualForRating } from './engine';
import { SPEC_QUOTED_DE_TCAN } from './fixtures';
import { QuoteRatingError, rateQuote, toBasis } from './quote';

/**
 * Trip Cancellation uses the specification-quoted fixture. The CFAR and Trip Interruption manuals are
 * SYNTHETIC: the same quoted tables with a different exposure, because neither filed manual is available.
 */
const tcan: ManualDocument = { ...SPEC_QUOTED_DE_TCAN, perilPackage: null };
const synthetic = (kind: ManualDocument['exposure']['kind']): ManualDocument => ({
  ...tcan,
  exposure: { kind, table: 'X.exposure' },
  tables: [
    ...tcan.tables,
    {
      id: 'X.exposure',
      name: 'Synthetic exposure factor',
      page: 'synthetic',
      keys: [{ input: 'tripCost', match: 'band' }],
      rows: [{ keys: [1], factor: '1.0000' }],
      unused: null,
      unknown: null,
    },
  ],
});
const manuals: Record<string, ManualDocument> = {
  TCAN: tcan,
  CFAR: synthetic('per_100_cfar_insured_cost'),
  TINT: synthetic('per_100_interruption_limit'),
};
const resolver = (benefit: string): ManualForRating => ({
  id: '00000000-0000-4000-8000-00000000000' + Object.keys(manuals).indexOf(benefit),
  code: `TEST-${benefit}`,
  version: 1,
  benefit,
  state: 'DE',
  illustrative: false,
  document: ManualDocumentSchema.parse(manuals[benefit]),
});

const base = (over: Partial<QuoteRatingRequest> = {}): QuoteRatingRequest => ({
  state: 'DE',
  rateDate: '2026-11-01',
  travellers: [
    { id: 'A', age: 45, preExistingWaived: true, costPerTraveller: '4200' },
    { id: 'B', age: 45, preExistingWaived: false, costPerTraveller: '4200' },
  ],
  trip: {
    purchaseDate: '2026-11-21',
    departureDate: '2026-12-11',
    returnDate: '2026-12-20',
    destinations: [{ region: 'Europe', days: 10 }],
    penaltyDays: 60,
  },
  account: { businessSegment: 'OTA - Cruise', notCollected: [] },
  benefits: [
    {
      benefit: 'TCAN',
      plan: { packageType: 'optional', perils: [], waivedExclusions: [], supplemental: [] },
    },
  ],
  ...over,
});
const plan = {
  packageType: 'optional' as const,
  perils: [],
  waivedExclusions: [],
  supplemental: [],
};

describe('multi-benefit quote rating (E02-F05)', () => {
  it('rates each benefit for each traveller and totals per traveller, benefit and policy', () => {
    const r = rateQuote(
      base({
        benefits: [
          { benefit: 'TCAN', plan },
          { benefit: 'TINT', plan: { ...plan, interruption: { limitPercent: 150 } } },
        ],
      }),
      resolver,
    );
    expect(r.lines).toHaveLength(4);
    const amounts = r.lines.map((l) => new Decimal(l.result.amount));
    expect(r.policyTotal).toBe(amounts.reduce((a, b) => a.plus(b)).toFixed(2));
    expect(r.perTraveller.map((p) => p.travellerId)).toEqual(['A', 'B']);
    expect(new Decimal(r.perTraveller[0]!.total).plus(r.perTraveller[1]!.total).toFixed(2)).toBe(
      r.policyTotal,
    );
    expect(r.perBenefit.map((b) => b.benefit)).toEqual(['TCAN', 'TINT']);
    // Trip Interruption rates on its multiple of trip cost: 150% of 4,200.
    const ti = r.lines.find((l) => l.benefit === 'TINT')!.result;
    expect(ti.steps.find((s) => s.step === 'derived.interruptionLimit')!.value).toBe('6300');
    expect(r.kind).toBe('loss_cost');
  });

  it('rates CFAR on its reimbursement percentage of the air or trip cost, only when eligible', () => {
    const cfar = (over: object) => ({
      benefit: 'CFAR',
      plan: { ...plan, cfar: { percent: 75, basis: 'trip' as const } },
      ...over,
    });
    const ok = rateQuote(
      base({
        benefits: [
          cfar({ cfarEligibility: { passed: true, reference: 'rules v1 (test)', reasons: [] } }),
        ],
      }),
      resolver,
    );
    expect(
      ok.lines[0]!.result.steps.find((s) => s.step === 'derived.cfarInsuredAmount')!.value,
    ).toBe('3150');
    const air = rateQuote(
      base({
        benefits: [
          {
            benefit: 'CFAR',
            plan: { ...plan, cfar: { percent: 50, basis: 'air', airCost: '1200' } },
            cfarEligibility: { passed: true, reference: 'test', reasons: [] },
          },
        ],
      }),
      resolver,
    );
    expect(
      air.lines[0]!.result.steps.find((s) => s.step === 'derived.cfarInsuredAmount')!.value,
    ).toBe('600');

    const notEligible = rateQuote(
      base({
        benefits: [
          { benefit: 'TCAN', plan },
          cfar({
            cfarEligibility: {
              passed: false,
              reference: 'test',
              reasons: ['Bought outside the time-sensitive period'],
            },
          }),
        ],
      }),
      resolver,
    );
    expect(notEligible.notRated).toEqual([
      { benefit: 'CFAR', reasons: ['Bought outside the time-sensitive period'] },
    ]);
    expect(notEligible.lines.every((l) => l.benefit === 'TCAN')).toBe(true);

    expect(() => rateQuote(base({ benefits: [cfar({})] }), resolver)).toThrow(
      /eligibility decision/,
    );
  });

  it('reports every problem at once and gives no total', () => {
    try {
      rateQuote(
        base({
          travellers: [
            { id: 'A', age: null, costPerTraveller: '4200' },
            { id: 'B', age: 45, preExistingWaived: true, costPerTraveller: '100' },
          ],
        }),
        resolver,
      );
      throw new Error('expected an error');
    } catch (err) {
      expect(err).toBeInstanceOf(QuoteRatingError);
      expect((err as QuoteRatingError).problems.map((p) => p.travellerId)).toEqual(['A', 'B']);
    }
  });

  it('divides the reservation total when per-traveller costs are not given', () => {
    const r = rateQuote(
      base({
        travellers: [
          { id: 'A', age: 45, preExistingWaived: true },
          { id: 'B', age: 45, preExistingWaived: true },
        ],
        trip: { ...base().trip, reservationTotal: '8400' },
      }),
      resolver,
    );
    expect(r.lines[0]!.result.steps.find((s) => s.step === 'input.tripCost')!.value).toBe('4200');
  });

  it('meets the latency budget with room to spare: ten benefits for six travellers (engine only)', () => {
    const travellers = Array.from({ length: 6 }, (_, i) => ({
      id: `T${i}`,
      age: 45,
      preExistingWaived: true,
      costPerTraveller: '4200',
    }));
    const benefits = Array.from({ length: 10 }, (_, i) =>
      i % 2
        ? { benefit: 'TINT', plan: { ...plan, interruption: { limitPercent: 150 } } }
        : { benefit: 'TCAN', plan },
    );
    rateQuote(base({ travellers, benefits }), resolver); // warm up
    const runs = 20;
    const started = performance.now();
    for (let i = 0; i < runs; i++) rateQuote(base({ travellers, benefits }), resolver);
    const ms = (performance.now() - started) / runs;
    expect(ms).toBeLessThan(100);
  });
});

describe('billing basis (E02-F06-S01)', () => {
  const ctx = { totalTripCost: new Decimal(8400), tripDays: 10, travellers: 2 };
  const p = new Decimal('250');
  it('expresses the premium on each basis, with combinations', () => {
    expect(toBasis(p, { basis: 'per_policy', approval: null }, ctx)).toMatchObject({
      amount: '250.0000',
      unit: 'per policy',
      approved: false,
    });
    expect(toBasis(p, { basis: 'per_100_trip_cost', approval: null }, ctx).amount).toBe('2.9762');
    expect(toBasis(p, { basis: 'per_100_limit', limit: '10000', approval: null }, ctx).amount).toBe(
      '2.5000',
    );
    expect(toBasis(p, { basis: 'per_day', approval: null }, ctx).amount).toBe('12.5000');
    expect(
      toBasis(
        p,
        {
          basis: 'fixed_monthly',
          expectedPoliciesPerMonth: 40,
          approval: { approvedBy: 'actuary', approvedOn: '2026-11-01' },
        },
        ctx,
      ),
    ).toMatchObject({ amount: '10000.0000', approved: true });
    expect(
      toBasis(p, { basis: 'per_day', fixedFeePerPolicy: '50', approval: null }, ctx),
    ).toMatchObject({ amount: '10.0000', fixedFeePerPolicy: '50.00' });
  });
  it('needs the parameters the method uses', () => {
    expect(() => toBasis(p, { basis: 'per_100_limit', approval: null }, ctx)).toThrow(
      /give the limit/,
    );
    expect(() => toBasis(p, { basis: 'fixed_monthly', approval: null }, ctx)).toThrow(
      /expected policies per month/,
    );
  });
});
