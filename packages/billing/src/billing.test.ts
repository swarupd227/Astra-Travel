import { describe, expect, it } from 'vitest';
import type { CommissionRuleDocument } from '@astra/contracts';
import {
  addToTotals,
  buildMoney,
  clawback,
  commissionOnCharge,
  compareTotals,
  emptyTotals,
  mulPercent,
  spread,
  totalsOf,
  type RecordInput,
} from './index';

/** Rates, percents and amounts here are SYNTHETIC test values, not filed or contracted ones. */
describe('spread', () => {
  it('always adds up to the total, by largest remainder', () => {
    const parts = spread(10000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(parts).toEqual([3334, 3333, 3333]);
  });
  it('keeps the sign of a refund', () => {
    const parts = spread(-100, [3, 1]);
    expect(parts).toEqual([-75, -25]);
    expect(spread(-1, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-1);
  });
  it('gives everything to the first part when no part has weight', () => {
    expect(spread(500, [0, 0])).toEqual([500, 0]);
    expect(spread(0, [5, 5])).toEqual([0, 0]);
  });
});

describe('mulPercent', () => {
  it('rounds half away from zero in cents', () => {
    expect(mulPercent(8400, 10)).toBe(840);
    expect(mulPercent(1, 50)).toBe(1);
    expect(mulPercent(-1, 50)).toBe(-1);
    expect(mulPercent(8400, 12.5)).toBe(1050);
    expect(mulPercent(333, 33.3333)).toBe(111);
  });
});

describe('commission (E08-F02-S01)', () => {
  const ctx = (premiumCents: number, before = 0, policies = 1) => ({
    premiumCents,
    monthPremiumBeforeCents: before,
    monthPolicies: policies,
  });
  it('pays none when the rule says none', () =>
    expect(commissionOnCharge({ kind: 'none' }, ctx(8400)).cents).toBe(0));
  it('flat: a percent of the charge', () =>
    expect(commissionOnCharge({ kind: 'flat', percent: 10 }, ctx(8400))).toMatchObject({
      cents: 840,
      ratePercent: '10.0000',
    }));
  const tiered: CommissionRuleDocument = {
    kind: 'tiered',
    tiers: [
      { upTo: 100, percent: 10 },
      { upTo: 200, percent: 15 },
      { upTo: null, percent: 20 },
    ],
  };
  it('tiered: marginal percents on the month’s premium so far', () => {
    // 60.00 so far; this charge of 100.00 spans the first tier (40.00 at 10%) and the second (60.00 at 15%).
    expect(commissionOnCharge(tiered, ctx(10000, 6000)).cents).toBe(400 + 900);
    // A charge wholly inside the last tier earns the last tier's percent.
    expect(commissionOnCharge(tiered, ctx(1000, 50000)).cents).toBe(200);
    // The first charge of the month starts at the first tier.
    expect(commissionOnCharge(tiered, ctx(5000)).cents).toBe(500);
  });
  const volume: CommissionRuleDocument = {
    kind: 'volume',
    bands: [
      { minPolicies: 0, percent: 5 },
      { minPolicies: 10, percent: 8 },
    ],
  };
  it('volume: the band for the month’s policy count', () => {
    expect(commissionOnCharge(volume, ctx(10000, 0, 9)).cents).toBe(500);
    expect(commissionOnCharge(volume, ctx(10000, 0, 10)).cents).toBe(800);
  });
  it('clawback takes back at the original rate (E08-F02-S01)', () => {
    expect(clawback(-8400, 10)).toBe(-840);
    expect(clawback(-4200, 0)).toBeCloseTo(0);
  });
});

describe('premium record money (E08-F01, E08-F02)', () => {
  const base: RecordInput = {
    premiumCents: 12600,
    benefits: [
      { code: 'trip_cancellation', arrangement: 'VSC', weight: 8400 },
      { code: 'trip_interruption', arrangement: 'ABIC', weight: 4200 },
    ],
    travellers: [{ id: 'T1', weight: 12600 }],
    state: 'DE',
    taxRates: { VSC: 2, ABIC: 3 },
    commission: {
      rule: { kind: 'flat', percent: 10 },
      monthPremiumBeforeCents: 0,
      monthPolicies: 1,
      originalRatePercent: null,
    },
    accountLabel: 'Account A',
    date: '2026-12-01',
  };
  it('splits premium by entity so the totals equal the premium, and taxes each entity at its rate', () => {
    const m = buildMoney(base);
    expect(m.issues).toEqual([]);
    expect(m.allocation.map((l) => [l.entity, l.premium, l.tax])).toEqual([
      ['VSC', '84.00', '1.68'],
      ['ABIC', '42.00', '1.26'],
    ]);
    expect(m.allocation.reduce((a, l) => a + Number(l.premium), 0)).toBeCloseTo(126);
    expect(m.taxCents).toBe(168 + 126);
    expect(m.commission).toMatchObject({ amount: '12.60', rule: 'Flat 10%' });
    expect(m.perBenefit.map((b) => b.premium)).toEqual(['84.00', '42.00']);
  });
  it('shows the CLIP arrangement under VSC’s entity', () => {
    const m = buildMoney({
      ...base,
      benefits: [
        { code: 'a', arrangement: 'VSC_CLIP', weight: 1 },
        { code: 'b', arrangement: 'VSC', weight: 1 },
      ],
    });
    expect(m.allocation.map((l) => [l.entity, l.arrangement])).toEqual([
      ['VSC', 'VSC_CLIP'],
      ['VSC', 'VSC'],
    ]);
  });
  it('holds the record, saying why, rather than guess a missing rate, arrangement or rule', () => {
    const noTax = buildMoney({ ...base, taxRates: { VSC: 2 } });
    expect(noTax.issues.join(' ')).toContain(
      'No premium tax rate is loaded for DE and ABIC on 2026-12-01',
    );
    expect(noTax.taxCents).toBeNull();
    const unassigned = buildMoney({
      ...base,
      benefits: [{ code: 'x', arrangement: null, weight: 1 }],
    });
    expect(unassigned.issues.join(' ')).toContain('no underwriting arrangement');
    const noRule = buildMoney({ ...base, commission: { ...base.commission, rule: null } });
    expect(noRule.issues.join(' ')).toContain('no approved commission rule');
    expect(noRule.commission).toBeNull();
  });
  it('claws commission back on a refund at the original rate, and refunds tax with it', () => {
    const m = buildMoney({
      ...base,
      premiumCents: -8400,
      benefits: [{ code: 'trip_cancellation', arrangement: 'VSC', weight: 8400 }],
      commission: { ...base.commission, originalRatePercent: 10 },
    });
    expect(m.issues).toEqual([]);
    expect(m.commission).toMatchObject({
      amount: '-8.40',
      rule: expect.stringContaining('Clawback'),
    });
    expect(m.allocation[0]).toMatchObject({ premium: '-84.00', tax: '-1.68' });
    // Without the original rate the clawback cannot be calculated.
    expect(
      buildMoney({
        ...base,
        premiumCents: -100,
        commission: { ...base.commission, originalRatePercent: null },
      }).issues.join(' '),
    ).toContain('clawback cannot be calculated');
  });
  it('needs nothing when no premium moved', () => {
    const m = buildMoney({
      ...base,
      premiumCents: 0,
      commission: { ...base.commission, rule: null },
    });
    expect(m.issues).toEqual([]);
    expect(m.commission?.amount).toBe('0.00');
  });
});

describe('control totals (E08-F04-S01)', () => {
  it('sum charges, refunds, commission and tax, and are compared with what billing received', () => {
    const t = emptyTotals();
    addToTotals(t, { premiumCents: 8400, commissionCents: 840, taxCents: 168 });
    addToTotals(t, { premiumCents: -2400, commissionCents: -240, taxCents: -48 });
    const totals = totalsOf(t);
    expect(totals).toEqual({
      count: 2,
      premium: '60.00',
      charges: '84.00',
      refunds: '24.00',
      commission: '6.00',
      tax: '1.20',
    });
    expect(
      compareTotals(totals, { count: 2, premium: '60.00', commission: '6.00', tax: '1.20' }).ok,
    ).toBe(true);
    const bad = compareTotals(totals, {
      count: 1,
      premium: '84.00',
      commission: '6.00',
      tax: '1.20',
    });
    expect(bad.ok).toBe(false);
    expect(bad.differences).toEqual([
      'record count: sent 2, received 1',
      'premium: sent 60.00, received 84.00',
    ]);
  });
});
