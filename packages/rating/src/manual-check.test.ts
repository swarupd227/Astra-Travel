import { describe, expect, it } from 'vitest';
import type { ManualDocument } from '@astra/contracts';
import { locatePage, numbersOn, splitPages, verifyManualTables } from './manual-check';

/** A synthetic manual: invented pages and factors, in the shape of a filed manual's printed tables. */
const TEXT = [
  'Cover page RETR-X-1',
  'Table 2.1.5 Trip cost per $100\nFrom $1 1.0000\nFrom $501 .9000\nRETR-X-2',
  'Table 2.1.4 Age 45 waived 0.7200 not waived 0.6000 factors 1,250.5\nRETR-X-10',
].join('\f');
const pages = splitPages(TEXT, [0, TEXT.indexOf('\f') + 1, TEXT.lastIndexOf('\f') + 1]);

const doc = (tables: ManualDocument['tables']): ManualDocument =>
  ({
    baseLossCost: '1.475',
    exposure: { kind: 'per_100_trip_cost', table: '2.1.5' },
    minimumTripCost: null,
    variables: [],
    perilPackage: null,
    exclusionWaivers: null,
    supplemental: [],
    tables,
    conversion: { lossCostMultiplier: null, minimumPremium: null, roundTo: 2 },
  }) as ManualDocument;

const table = (id: string, page: string, factors: string[]): ManualDocument['tables'][number] => ({
  id,
  name: `Table ${id}`,
  page,
  keys: [{ input: 'age', match: 'band' }],
  rows: factors.map((factor, i) => ({ keys: [i], factor })),
  unused: null,
  unknown: null,
});

describe('manual page check (E02-F01-S02)', () => {
  it('reads numbers as numbers: .9000, 0.9 and 0.9000 are the same', () => {
    const n = numbersOn('From $501 .9000 and 1,250.5 and 2.1.4 and RETR-X-2');
    expect(n.has('0.9')).toBe(true);
    expect(n.has('1250.5')).toBe(true);
  });

  it('finds the page that prints a label, and does not take -1 for -10', () => {
    expect(locatePage('RETR-X-1', pages)).toBe(1);
    expect(locatePage('RETR-X-10', pages)).toBe(3);
    expect(locatePage('retr-x-2', pages)).toBe(2);
    expect(locatePage('RETR-X-7', pages)).toBeNull();
  });

  it('confirms factors that are printed on the cited page', () => {
    const r = verifyManualTables(doc([table('2.1.5', 'RETR-X-2', ['1.0000', '0.9000'])]), pages);
    expect(r[0]).toMatchObject({ ok: true, documentPage: 2, factorsFound: 2, missing: [] });
  });

  it('lists factors that are not on the page, including ones printed on another page', () => {
    const r = verifyManualTables(doc([table('2.1.5', 'RETR-X-2', ['1.0000', '0.7200'])]), pages);
    expect(r[0]).toMatchObject({ ok: false, factorsFound: 1 });
    expect(r[0]!.missing).toEqual(['1 → 0.7200']);
  });

  it('does not check a table whose page cannot be found', () => {
    const r = verifyManualTables(doc([table('2.1.5', 'RETR-X-9', ['1.0000'])]), pages);
    expect(r[0]).toMatchObject({ ok: false, documentPage: null });
    expect(r[0]!.detail).toContain('was not found as a single page');
  });

  it('checks the unused and unknown factors too', () => {
    const t = { ...table('2.1.4', 'RETR-X-10', ['0.7200']), unused: '0.6000', unknown: '0.5500' };
    const r = verifyManualTables(doc([t]), pages);
    expect(r[0]!.missing).toEqual(['unknown → 0.5500']);
  });
});
