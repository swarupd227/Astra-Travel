import { describe, expect, it } from 'vitest';
import {
  CatalogueDocumentSchema,
  PlanDocumentSchema,
  type PolicyEvent,
  type PolicySnapshot,
} from '@astra/contracts';
import {
  annualTermEnd,
  benefitLimits,
  coverageWindow,
  CoverageError,
  policyCoverage,
  reviewPeriodEnd,
} from './coverage';
import { canTransition, inForce, policyNumber, project } from './record';

/** Synthetic catalogue and plan: invented names, values and timing, in the shape the forms and plans use. */
const s = (key: string) => ({ source: 'schedule' as const, key });
const cat = CatalogueDocumentSchema.parse({
  benefits: [
    {
      code: 'trip_cancellation',
      name: 'Trip Cancellation',
      group: 'pre_departure',
      maximum: { variable: s('tc_max'), basis: { kind: 'variable', variable: s('tc_basis') } },
    },
    {
      code: 'cfar',
      name: 'Cancel for Any Reason',
      group: 'pre_departure',
      maximum: { variable: s('cfar_max'), basis: { kind: 'fixed', basis: 'per_person' } },
    },
    {
      code: 'baggage',
      name: 'Baggage',
      group: 'baggage',
      maximum: { variable: s('bag_max'), basis: { kind: 'fixed', basis: 'per_person' } },
    },
  ],
  coveredReasons: [],
  upgrades: [],
});
const plan = (timing: Record<string, unknown>) =>
  PlanDocumentSchema.parse({
    benefits: [
      { code: 'trip_cancellation', packaging: 'packaged' },
      { code: 'cfar', packaging: 'standalone_optional' },
      { code: 'baggage', packaging: 'packaged' },
    ],
    values: {
      'schedule:tc_max': 10000,
      'schedule:tc_basis': 'PER PERSON',
      'schedule:cfar_max': 7500,
    },
    timing,
  });
const trip = { purchaseDate: '2026-11-21', departureDate: '2026-12-11', returnDate: '2026-12-20' };

describe('coverage dates (E05-F03-S01)', () => {
  it('starts 12:01 a.m. the day after premium is received and ends at 11:59 p.m. on the return date', () => {
    expect(
      coverageWindow(
        { start: { kind: 'day_after_premium_received' }, end: { kind: 'return_date' } },
        trip,
      ),
    ).toEqual({ start: '2026-11-22T00:01', end: '2026-12-20T23:59' });
  });

  it('ends CFAR a set number of hours before departure, across a month end', () => {
    expect(
      coverageWindow(
        { start: { kind: 'purchase_date' }, end: { kind: 'hours_before_departure', hours: 48 } },
        trip,
      ),
    ).toEqual({ start: '2026-11-21T00:01', end: '2026-12-09T00:00' });
    expect(
      coverageWindow(
        { start: { kind: 'purchase_date' }, end: { kind: 'hours_before_departure', hours: 48 } },
        { ...trip, departureDate: '2026-12-01', returnDate: '2026-12-05' },
      ).end,
    ).toBe('2026-11-29T00:00');
  });

  it('starts post-departure cover at departure', () => {
    expect(
      coverageWindow({ start: { kind: 'departure' }, end: { kind: 'return_date' } }, trip).start,
    ).toBe('2026-12-11T00:01');
  });

  it('refuses cover that would end before it starts', () => {
    expect(() =>
      coverageWindow(
        {
          start: { kind: 'day_after_premium_received' },
          end: { kind: 'hours_before_departure', hours: 720 },
        },
        trip,
      ),
    ).toThrow(CoverageError);
  });

  it('sets each benefit from its own timing, else its group’s, and says when none is configured', () => {
    const doc = plan({
      pre_departure: {
        start: { kind: 'day_after_premium_received' },
        end: { kind: 'return_date' },
      },
      cfar: {
        start: { kind: 'purchase_date' },
        end: { kind: 'hours_before_departure', hours: 48 },
      },
      baggage: { start: { kind: 'departure' }, end: { kind: 'return_date' } },
    });
    const c = policyCoverage(
      doc,
      cat,
      ['trip_cancellation', 'cfar', 'baggage'],
      trip,
      'single_trip',
    );
    expect(c.perBenefit.trip_cancellation).toEqual({
      start: '2026-11-22T00:01',
      end: '2026-12-20T23:59',
    });
    expect(c.perBenefit.cfar).toEqual({ start: '2026-11-21T00:01', end: '2026-12-09T00:00' });
    expect(c.perBenefit.baggage!.start).toBe('2026-12-11T00:01');
    expect(c.term).toEqual({ start: '2026-11-21T00:01', end: '2026-12-20T23:59' });
    expect(() =>
      policyCoverage(
        plan({ cfar: { start: { kind: 'purchase_date' }, end: { kind: 'return_date' } } }),
        cat,
        ['trip_cancellation'],
        trip,
        'single_trip',
      ),
    ).toThrow(
      'The plan has no coverage timing for Trip Cancellation (benefit group pre departure)',
    );
  });
});

describe('annual term (E05-F03-S03)', () => {
  it('ends at 11:59 p.m. on the 364th day after the effective date', () => {
    expect(annualTermEnd('2026-01-01')).toBe('2026-12-31T23:59');
    expect(annualTermEnd('2027-03-01')).toBe('2028-02-28T23:59');
  });

  it('covers a trip that runs past the term only to the term end', () => {
    const doc = plan({
      pre_departure: { start: { kind: 'purchase_date' }, end: { kind: 'return_date' } },
      baggage: { start: { kind: 'purchase_date' }, end: { kind: 'return_date' } },
    });
    const c = policyCoverage(
      doc,
      cat,
      ['trip_cancellation'],
      { purchaseDate: '2026-01-01', departureDate: '2026-12-20', returnDate: '2027-01-10' },
      'annual',
    );
    expect(c.term).toEqual({ start: '2026-01-01T00:01', end: '2026-12-31T23:59' });
    expect(c.perBenefit.trip_cancellation!.end).toBe('2026-12-31T23:59');
  });
});

describe('review period and limits', () => {
  it('ends the review period at 11:59 p.m. the set days after purchase', () => {
    expect(reviewPeriodEnd('2026-11-21', 10)).toBe('2026-12-01T23:59');
  });

  it('reads a benefit’s filed maximum and basis from the plan’s values', () => {
    const doc = plan({});
    expect(benefitLimits(doc, cat, 'trip_cancellation')).toEqual({
      maximum: 10000,
      basis: 'PER PERSON',
    });
    expect(benefitLimits(doc, cat, 'cfar')).toEqual({ maximum: 7500, basis: 'per person' });
    expect(benefitLimits(doc, cat, 'baggage')).toEqual({ maximum: null, basis: 'per person' });
  });
});

describe('policy record as events (E05-F01)', () => {
  const snapshot = {
    number: 'ATP-2026-000001',
    term: { start: '2026-11-22T00:01', end: '2026-12-20T23:59' },
    trip: { destination: 'Europe' },
  } as unknown as PolicySnapshot;
  const ev = (
    seq: number,
    type: PolicyEvent['type'],
    at: string,
    data: Record<string, unknown>,
  ): PolicyEvent => ({
    seq,
    type,
    occurredAt: at,
    actor: 'u',
    actorName: null,
    reason: null,
    data,
  });
  const events = [
    ev(1, 'bound', '2026-11-21T10:00:00Z', snapshot as unknown as Record<string, unknown>),
    ev(2, 'details_changed', '2026-11-25T10:00:00Z', { patch: { trip: { destination: 'Asia' } } }),
    ev(3, 'status_changed', '2026-12-01T10:00:00Z', { to: 'cancelled' }),
  ];

  it('folds events up to a moment', () => {
    expect(project(events, '2026-11-20T00:00:00Z')).toBeNull();
    expect(project(events, '2026-11-22T00:00:00Z')).toMatchObject({
      status: 'active',
      record: { trip: { destination: 'Europe' } },
    });
    expect(project(events, '2026-11-30T00:00:00Z')).toMatchObject({
      status: 'active',
      record: { trip: { destination: 'Asia' } },
      appliedEvents: 2,
    });
    expect(project(events)).toMatchObject({ status: 'cancelled', appliedEvents: 3 });
  });

  it('refuses a history with a status change the lifecycle does not allow', () => {
    expect(canTransition('active', 'cancelled')).toBe(true);
    expect(canTransition('cancelled', 'active')).toBe(false);
    expect(() =>
      project([...events, ev(4, 'status_changed', '2026-12-02T10:00:00Z', { to: 'active' })]),
    ).toThrow('not allowed');
  });

  it('is in force only while active and inside the benefit’s window', () => {
    const w = { start: '2026-11-22T00:01', end: '2026-12-20T23:59' };
    expect(inForce('active', w, '2026-12-01T12:00')).toBe(true);
    expect(inForce('active', w, '2026-11-21T23:59')).toBe(false);
    expect(inForce('cancelled', w, '2026-12-01T12:00')).toBe(false);
  });

  it('numbers policies with the year and the sequence', () => {
    expect(policyNumber(2026, 123)).toBe('ATP-2026-000123');
  });
});
