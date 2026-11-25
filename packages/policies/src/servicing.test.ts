import { describe, expect, it } from 'vitest';
import { cancellationMoney, changeMoney, fromCents, reviewStatus, toCents, withinDays } from './servicing';

/** Amounts and dates here are SYNTHETIC. */
describe('cents', () => {
  it('round-trips amounts exactly', () => {
    expect(toCents('84.00')).toBe(8400);
    expect(toCents('0.5')).toBe(50);
    expect(toCents('-12.34')).toBe(-1234);
    expect(fromCents(8400)).toBe('84.00');
    expect(fromCents(-5)).toBe('-0.05');
    expect(() => toCents('1.234')).toThrow();
  });
});

describe('review period (E06-F01-S01)', () => {
  const s = { reviewPeriodEndsAt: '2026-12-05T23:59', trip: { departureDate: '2026-12-20' } };
  it('runs to its end date', () => {
    expect(reviewStatus(s, '2026-12-05T23:59')).toEqual({ inReview: true, endsAt: '2026-12-05T23:59' });
    expect(reviewStatus(s, '2026-12-06T00:00').inReview).toBe(false);
  });
  it('ends automatically at departure when that is sooner', () => {
    const early = { reviewPeriodEndsAt: '2026-12-25T23:59', trip: { departureDate: '2026-12-20' } };
    expect(reviewStatus(early, '2026-12-19T23:59')).toEqual({ inReview: true, endsAt: '2026-12-20T00:00' });
    expect(reviewStatus(early, '2026-12-20T00:01').inReview).toBe(false);
  });
  it('is not running when the plan has no review period', () => {
    expect(reviewStatus({ reviewPeriodEndsAt: null, trip: {} }, '2026-12-01T10:00').inReview).toBe(false);
  });
});

describe('cancellation refund (E06-F01)', () => {
  const base = { termStart: '2026-12-01T00:01', termEnd: '2026-12-31T23:59', nowLocal: '2026-12-10T12:00' };
  it('refunds everything in the review period with no loss', () => {
    expect(cancellationMoney('84.00', { ...base, inReview: true, noLoss: true, rule: 'none' })).toMatchObject({ refund: '84.00', retained: '0.00', basis: 'review_period' });
  });
  it('refunds nothing in the review period when a loss has been reported', () => {
    expect(cancellationMoney('84.00', { ...base, inReview: true, noLoss: false, rule: 'none' })).toMatchObject({ refund: '0.00', retained: '84.00', basis: 'loss_reported' });
  });
  it('treats the premium as non-refundable after the review period (the filed sample form)', () => {
    expect(cancellationMoney('84.00', { ...base, inReview: false, noLoss: true, rule: 'none' })).toMatchObject({ refund: '0.00', retained: '84.00', basis: 'non_refundable' });
  });
  it('lets a state rule override: pro rata by unexpired days', () => {
    const r = cancellationMoney('100.00', { termStart: '2026-12-01T00:00', termEnd: '2026-12-31T00:00', nowLocal: '2026-12-16T00:00', inReview: false, noLoss: true, rule: 'pro_rata' });
    expect(r).toMatchObject({ refund: '50.00', retained: '50.00', basis: 'pro_rata' });
    // Before cover starts, all of it is unexpired.
    expect(cancellationMoney('100.00', { termStart: '2026-12-01T00:00', termEnd: '2026-12-31T00:00', nowLocal: '2026-11-20T00:00', inReview: false, noLoss: true, rule: 'pro_rata' }).refund).toBe('100.00');
  });
});

describe('change money (E06-F02)', () => {
  it('charges an increase', () => expect(changeMoney(1250, { inReview: false, rule: 'none' })).toMatchObject({ charge: '12.50', refund: '0.00' }));
  it('refunds a decrease in the review period', () => expect(changeMoney(-1250, { inReview: true, rule: 'none' })).toMatchObject({ refund: '12.50', retained: '0.00' }));
  it('keeps a decrease after the review period unless the plan refunds', () => {
    expect(changeMoney(-1250, { inReview: false, rule: 'none' })).toMatchObject({ refund: '0.00', retained: '12.50', basis: 'non_refundable' });
    expect(changeMoney(-1250, { inReview: false, rule: 'pro_rata' })).toMatchObject({ refund: '12.50', retained: '0.00' });
  });
  it('keeps a decrease when a loss has been reported, even in the review period', () => {
    expect(changeMoney(-1250, { inReview: true, rule: 'none', lossFree: false })).toMatchObject({ refund: '0.00', retained: '12.50' });
  });
  it('is quiet when nothing changes', () => expect(changeMoney(0, { inReview: true, rule: 'none' }).basis).toBe('none'));
});

describe('time limits', () => {
  it('has none until one is set', () => expect(withinDays('2026-12-01', '2030-01-01', null)).toBe(true));
  it('counts days from purchase', () => {
    expect(withinDays('2026-12-01', '2026-12-11', 10)).toBe(true);
    expect(withinDays('2026-12-01', '2026-12-12', 10)).toBe(false);
  });
});
