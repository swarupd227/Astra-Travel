import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { PolicySnapshot } from '@astra/contracts';
import { assemble, type AssemblyVariable, type ResolvedValue } from './assemble';
import { changeNotice, cancellationNotice, diffRecords, purchaseConfirmation, guideToBenefits } from './builders';
import { toText } from './model';
import { renderPdf } from './pdf';
import { dollars, numberToWords, wordsAndFigures } from './words';

/**
 * The wording is quoted from the product specification (M1), which quotes the filed VSC form and schedule; the
 * values chosen below are invented for the tests.
 */
const TEXT = [
  'You may cancel within the [ten (10) - fifteen (15)] day review period.',
  'We will reimburse [twenty-five percent (25%) – one hundred percent (100%)] of the Trip Cost.',
  'Trip Cancellation maximum per person [$0-$5,000,000].',
  '[[Optional] Trip Delay maximum [$100-$10,000] per person]',
  'cancel your [cruise][tour][trip] arrangements',
  'no later than [twenty-four (24) – one hundred sixty-eight (168) hours] before departure',
  'Maximum Benefit [PER PERSON] [PER TRIP].',
  'We do not cover travel to <<insert list of countries>>.',
].join('\n');

const at = (excerpt: string) => {
  const start = TEXT.indexOf(excerpt);
  if (start < 0) throw new Error(excerpt);
  return { start, end: start + excerpt.length, excerpt };
};
const v = (ref: string, excerpt: string, type: string, constraints: Record<string, unknown> = {}): AssemblyVariable => ({ ref, label: ref.split(':')[1]!, type, constraints, ...at(excerpt) });
const VARIABLES: AssemblyVariable[] = [
  v('schedule:review', '[ten (10) - fifteen (15)]', 'time_period', { min: 10, max: 15, unit: 'days' }),
  v('schedule:cfar_pct', '[twenty-five percent (25%) – one hundred percent (100%)]', 'percentage_range', { min: 25, max: 100, bases: [] }),
  v('schedule:tc_max', '[$0-$5,000,000]', 'numeric_range', { min: 0, max: 5_000_000, unit: 'usd' }),
  v('schedule:delay_on', '[[Optional] Trip Delay maximum [$100-$10,000] per person]', 'optional_benefit'),
  v('schedule:delay_max', '[$100-$10,000]', 'numeric_range', { min: 100, max: 10_000, unit: 'usd' }),
  v('schedule:kinds', '[cruise][tour][trip]', 'wording_choice', { options: ['cruise', 'tour', 'trip'], multiple: true }),
  v('schedule:notice', '[twenty-four (24) – one hundred sixty-eight (168) hours]', 'time_period', { min: 24, max: 168, unit: 'hours' }),
  v('schedule:basis', '[PER PERSON] [PER TRIP]', 'limit_basis', { options: ['PER PERSON', 'PER TRIP'] }),
  v('schedule:countries', '<<insert list of countries>>', 'insert_placeholder', { source: 'dataset', dataset: 'prohibited_destinations' }),
];
const VALUES = (over: Record<string, ResolvedValue> = {}): Map<string, ResolvedValue> =>
  new Map<string, ResolvedValue>(
    Object.entries({
      'schedule:review': 10,
      'schedule:cfar_pct': { percent: 100 },
      'schedule:tc_max': 500_000,
      'schedule:delay_on': true,
      'schedule:delay_max': 2500,
      'schedule:kinds': ['cruise', 'tour'],
      'schedule:notice': 48,
      'schedule:basis': 'PER PERSON',
      'schedule:countries': 'Atlantis, Ruritania',
      ...over,
    }),
  );

describe('numbers in the filed format (E09-F01-S01)', () => {
  it('writes numbers as words and figures', () => {
    expect(numberToWords(0)).toBe('zero');
    expect(numberToWords(24)).toBe('twenty-four');
    expect(numberToWords(100)).toBe('one hundred');
    expect(numberToWords(168)).toBe('one hundred sixty-eight');
    expect(numberToWords(1500)).toBe('one thousand five hundred');
    expect(wordsAndFigures(10)).toBe('ten (10)');
    expect(() => numberToWords(-1)).toThrow(RangeError);
  });
  it('writes dollars with thousands separators', () => {
    expect(dollars(500000)).toBe('$500,000');
    expect(dollars(2500.5)).toBe('$2,500.50');
  });
});

describe('assembly of a filed form (E09-F01-S01)', () => {
  it('keeps the selected options and inserts the values, with no brackets left', () => {
    const r = assemble(TEXT, VARIABLES, VALUES());
    expect(r.problems).toEqual([]);
    expect(r.text).toBe(
      [
        'You may cancel within the ten (10) day review period.',
        'We will reimburse one hundred percent (100%) of the Trip Cost.',
        'Trip Cancellation maximum per person $500,000.',
        'Trip Delay maximum $2,500 per person',
        'cancel your cruise, tour arrangements',
        'no later than forty-eight (48) hours before departure',
        'Maximum Benefit PER PERSON.',
        'We do not cover travel to Atlantis, Ruritania.',
      ].join('\n'),
    );
    expect(r.text).not.toMatch(/[[\]<>]/);
    expect(r.removed).toEqual([]);
  });

  it('removes an optional benefit that the plan does not offer, with its line', () => {
    const r = assemble(TEXT, VARIABLES, VALUES({ 'schedule:delay_on': false }));
    expect(r.problems).toEqual([]);
    expect(r.text).not.toContain('Trip Delay');
    expect(r.text.split('\n')).toHaveLength(7);
    expect(r.removed).toEqual(['schedule:delay_on']);
  });

  it('does not need a value for wording inside a benefit that was removed', () => {
    const values = VALUES({ 'schedule:delay_on': false });
    values.delete('schedule:delay_max');
    expect(assemble(TEXT, VARIABLES, values).problems).toEqual([]);
  });

  it('fails, naming the wording, when the plan gives no value', () => {
    const values = VALUES();
    values.delete('schedule:tc_max');
    const r = assemble(TEXT, VARIABLES, values);
    expect(r.problems).toEqual([expect.objectContaining({ variable: 'schedule:tc_max', message: 'The plan gives no value for “tc_max”.' }), expect.objectContaining({ variable: null, message: expect.stringContaining('A bracket is left in the document') })]);
  });

  it('fails when a value is not in a form the wording can take', () => {
    const r = assemble(TEXT, VARIABLES, VALUES({ 'schedule:review': 10.5 }));
    expect(r.problems[0]).toMatchObject({ variable: 'schedule:review' });
  });

  it('refuses wording the variable map does not cover rather than issue a bracket', () => {
    const r = assemble(`${TEXT}\nAnd [an unmapped option] too.`, VARIABLES, VALUES());
    expect(r.problems).toEqual([expect.objectContaining({ variable: null, message: expect.stringContaining('[an unmapped option]') })]);
  });

  it('refuses spans that overlap without nesting', () => {
    const bad: AssemblyVariable = { ...v('schedule:x', '[$0-$5,000,000]', 'numeric_range', { unit: 'usd' }), start: VARIABLES[2]!.start + 3, end: VARIABLES[2]!.end + 8 };
    expect(assemble(TEXT, [...VARIABLES, bad], VALUES()).problems.some((p) => p.variable === 'schedule:x' && p.message.includes('overlaps'))).toBe(true);
  });
});

describe('documents the platform writes (E09-F01-S02, E09-F01-S03)', () => {
  const snapshot = (over: Partial<PolicySnapshot> = {}): PolicySnapshot =>
    ({
      number: 'ATP-2026-000007',
      quoteId: '00000000-0000-4000-8000-000000000001',
      plan: { planId: '00000000-0000-4000-8000-000000000002', code: 'Q-DE', name: 'Quote plan, Delaware', versionId: '00000000-0000-4000-8000-000000000003', version: 2, state: 'DE', term: 'single_trip' },
      ruleSet: { id: '00000000-0000-4000-8000-000000000004', version: 1 },
      manuals: {},
      disclosure: { version: 'd1', title: 'Delaware disclosure', acknowledgedBy: 'Pat Sample', acknowledgedAt: '2026-11-25T10:00:00.000Z' },
      payment: { reference: 'PAY-1', amount: '126.00' },
      purchaser: { name: 'Pat Sample', email: 'pat@example.com' },
      travellers: [{ id: 'T1', firstName: 'Pat', lastName: 'Sample', dateOfBirth: '1980-05-05', age: 46, costPerTraveller: '4200' }],
      trip: { departureDate: '2026-12-15', returnDate: '2026-12-24', destinations: [{ country: 'FR', region: 'Europe' }], supplier: 'Sample Cruises' },
      benefits: [
        { code: 'trip_cancellation', name: 'Trip Cancellation', group: 'pre_departure', packaging: 'packaged', underwriter: 'VSC', limits: { maximum: 5000, basis: 'per person' }, premium: '84.00', coverageStart: '2026-11-26T00:01', coverageEnd: '2026-12-24T23:59' },
        { code: 'trip_interruption', name: 'Trip Interruption', group: 'post_departure', packaging: 'standalone_optional', underwriter: 'ABIC', limits: { maximum: 7500, basis: 'per person' }, premium: '42.00', coverageStart: '2026-12-15T00:01', coverageEnd: '2026-12-24T23:59' },
      ],
      premium: { kind: 'premium', total: '126.00', perBenefit: [], perTraveller: [], basis: null },
      purchasedOn: '2026-11-25',
      reviewPeriodEndsAt: '2026-12-05T23:59',
      term: { start: '2026-11-26T00:01', end: '2026-12-24T23:59' },
      waiver: { applies: true, conditions: [] },
      cfar: { offered: false, noticePeriod: null },
      ...over,
    }) as PolicySnapshot;

  it('confirms trip cost, benefits, limits and premium', () => {
    const text = toText(purchaseConfirmation(snapshot()));
    for (const s of ['Purchase Confirmation', 'ATP-2026-000007', 'Pat Sample | $4,200.00', 'Trip Cancellation | $5,000 per person', 'American Bankers Insurance Company of Florida', '$126.00', 'Review period ends: 2026-12-05 23:59', 'Delaware disclosure']) expect(text).toContain(s);
  });

  it('lists what changed between two moments of a policy', () => {
    const before = snapshot();
    const after = snapshot({ trip: { ...before.trip, returnDate: '2026-12-28' }, premium: { ...before.premium, total: '135.00' }, benefits: [before.benefits[0]!] });
    const changes = diffRecords(before, after);
    expect(changes.map((c) => c.path).sort()).toEqual(['benefits.trip_interruption', 'premium.total', 'trip.returnDate']);
    const text = toText(changeNotice(before, after, { occurredAt: '2026-11-30T12:00:00.000Z', actorName: 'Sam Service', actor: 'svc', reason: 'The trip was extended' }));
    expect(text).toContain('Return date | 2026-12-24 | 2026-12-28');
    expect(text).toContain('Total premium | 126.00 | 135.00');
    expect(text).toContain('Reason: The trip was extended');
  });

  it('says plainly when nothing changed, and writes cancellation notices', () => {
    expect(toText(changeNotice(snapshot(), snapshot(), { occurredAt: '2026-11-30T12:00:00.000Z', actorName: null, actor: 'x', reason: null }))).toContain('Nothing on the policy record changed.');
    expect(toText(cancellationNotice(snapshot(), { occurredAt: '2026-11-30T12:00:00.000Z', reason: 'Cancelled in the review period' }, 'cancelled'))).toContain('Cancelled on: 2026-11-30');
  });

  it('produces a guide from the programme, master policy and plan benefits', () => {
    const text = toText(guideToBenefits({ programme: { code: 'GOLD-US', name: 'Gold Card', cardProduct: 'Gold', states: ['DE', 'FL'] }, masterPolicy: { policyNumber: 'MP-1', underwriter: 'VSC', effectiveFrom: '2026-01-01', effectiveTo: null }, plan: { code: 'Q-DE', name: 'Quote plan', version: 2 }, benefits: [{ name: 'Trip Cancellation', limit: { maximum: 5000, basis: 'per person' }, underwriter: 'VSC' }], version: 3 }));
    expect(text).toContain('Guide to Benefits');
    expect(text).toContain('Gold Card · Gold · version 3');
    expect(text).toContain('Trip Cancellation | $5,000 per person | VSC');
  });
});

describe('PDF output', () => {
  it('renders a multi-page PDF, keeping typographic characters and replacing what the font cannot draw', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of the form: cover for a “trip” – within limits, as filed.`).join('\n\n');
    const bytes = await renderPdf({ title: 'Schedule', subtitle: 'ATP-1', blocks: [{ kind: 'pairs', rows: [['Policy', 'ATP-1 ✓']] }, { kind: 'paragraph', text: long }, { kind: 'table', head: ['A', 'B'], rows: [['one', 'two']] }] });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(3000);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(2);
  });
});
