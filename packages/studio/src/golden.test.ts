import { describe, expect, it } from 'vitest';
import { findBrackets } from './brackets';
import { compareToGolden, type GoldenVariable } from './golden';

/**
 * The wording is quoted from the product specification (M1), which quotes the filed VSC form and schedule.
 * The golden list below was prepared by hand from that wording, not generated from the reading rules.
 * When Assurant provides the sample schedule, its manually prepared list replaces this one.
 */
const WORDING = [
  'You may cancel within the [ten (10) - fifteen (15)] day review period.',
  'We will reimburse [twenty-five percent (25%) – one hundred percent (100%)] of the Trip Cost.',
  'Trip Cancellation maximum per person [$0-$5,000,000].',
  '[[Optional] Trip Delay maximum [$100-$10,000] per person]',
  'Maximum Benefit [PER PERSON] [PER TRIP].',
].join('\n');

const GOLDEN: GoldenVariable[] = [
  {
    excerpt: '[ten (10) - fifteen (15)]',
    type: 'time_period',
    constraints: { min: 10, max: 15, unit: 'days' },
  },
  {
    excerpt: '[twenty-five percent (25%) – one hundred percent (100%)]',
    type: 'percentage_range',
    constraints: { min: 25, max: 100, bases: [] },
  },
  {
    excerpt: '[$0-$5,000,000]',
    type: 'numeric_range',
    constraints: { min: 0, max: 5_000_000, unit: 'usd' },
  },
  {
    excerpt: '[[Optional] Trip Delay maximum [$100-$10,000] per person]',
    type: 'optional_benefit',
    constraints: {},
  },
  {
    excerpt: '[$100-$10,000]',
    type: 'numeric_range',
    constraints: { min: 100, max: 10_000, unit: 'usd' },
  },
  {
    excerpt: '[PER PERSON] [PER TRIP]',
    type: 'limit_basis',
    constraints: { options: ['PER PERSON', 'PER TRIP'] },
  },
];

const fromRules = (): GoldenVariable[] =>
  findBrackets(WORDING)
    .filter((b) => b.suggestion)
    .map((b) => ({
      excerpt: b.text,
      type: b.suggestion!.type,
      constraints: b.suggestion!.constraints as Record<string, unknown>,
    }));

describe('golden list comparison (E01-F01-S03)', () => {
  it('finds every manually listed variable in the form-reading rule’s baseline', () => {
    const c = compareToGolden(fromRules(), GOLDEN);
    expect(c.missing).toEqual([]);
    expect(c.mismatched).toEqual([]);
    expect(c.recall).toBe(1);
  });

  it('says what is missing, what differs in type or range, and what is extra', () => {
    const proposed = fromRules()
      .filter((p) => p.excerpt !== '[$0-$5,000,000]')
      .map((p) =>
        p.excerpt === '[ten (10) - fifteen (15)]'
          ? { ...p, constraints: { min: 10, max: 14, unit: 'days' } }
          : p,
      )
      .concat({ excerpt: '[an invented one]', type: 'optional_benefit', constraints: {} });
    const c = compareToGolden(proposed, GOLDEN);
    expect(c.missing).toEqual(['[$0-$5,000,000]']);
    expect(c.mismatched.map((m) => m.excerpt)).toEqual(['[ten (10) - fifteen (15)]']);
    expect(c.extra).toEqual(['[an invented one]']);
    expect(c.recall).toBeCloseTo(4 / 6);
  });

  it('ignores the order of constraint fields', () => {
    const c = compareToGolden(
      [{ excerpt: 'x', type: 'numeric_range', constraints: { unit: 'usd', max: 2, min: 1 } }],
      [{ excerpt: 'x', type: 'numeric_range', constraints: { min: 1, max: 2, unit: 'usd' } }],
    );
    expect(c.recall).toBe(1);
  });
});
