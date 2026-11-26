import { describe, expect, it } from 'vitest';
import type { FeedMappingDocument } from '@astra/contracts';
import { convertDate, convertLines, maskCardNumbers, missingColumns, previewMapping, splitLine } from './mapping';

const mapping: FeedMappingDocument = {
  delimiter: ';',
  columns: {
    accountRef: { column: 'Customer Token' },
    productCode: { column: 'Card', values: { 'Gold Travel': 'GOLD' } },
    action: { column: 'Change', values: { new: 'A', changed: 'U', closed: 'D' } },
    eligibleFrom: { column: 'Opened', format: 'DD/MM/YYYY' },
    eligibleTo: { column: 'Ends', format: 'DD/MM/YYYY' },
  },
};
const header = { programmeCode: 'SYN-PROG', sequence: 1, kind: 'CHANGE' as const, asOfDate: '2026-11-01' };
// Synthetic issuer file.
const sample = [
  'Customer Token;Card;Change;Opened;Ends',
  'tok-0001;Gold Travel;new;01/10/2026;',
  'tok-0002;"Gold Travel";closed;15/09/2026;31/10/2026',
  'tok-0003;Gold Travel;new;31/02/2026;',
  '4111 1111 1111 1111;Gold Travel;new;01/10/2026;',
  '',
].join('\r\n');

describe('feed mapping', () => {
  it('reads quoted fields and converts dates only when they are real', () => {
    expect(splitLine('a;"b;c";"say ""hi""";', ';')).toEqual(['a', 'b;c', 'say "hi"', '']);
    expect(convertDate('01/10/2026', 'DD/MM/YYYY')).toBe('2026-10-01');
    expect(convertDate('01/10/2026', 'MM/DD/YYYY')).toBe('2026-01-10');
    expect(convertDate('20261001', 'YYYYMMDD')).toBe('2026-10-01');
    expect(convertDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
  });

  it('removes card numbers but leaves other long numbers', () => {
    const r = maskCardNumbers('ref 5500 0000 0000 0004; order 1234567890123');
    expect(r).toEqual({ text: 'ref 4111111111111111; order 1234567890123', removed: 1 });
  });

  it('names missing columns', () => {
    expect(missingColumns('Customer Token;Card', mapping)).toEqual(['Change', 'Opened', 'Ends']);
  });

  it('produces the feed format with control totals', async () => {
    const lines: string[] = [];
    for await (const l of convertLines(sample.split('\n'), mapping, header)) lines.push(l);
    expect(lines[0]).toBe('H|ASTRA-ELIG|1|SYN-PROG|1|CHANGE|2026-11-01');
    expect(lines[1]).toBe('D|tok-0001|GOLD|A|2026-10-01|');
    expect(lines[2]).toBe('D|tok-0002|GOLD|D|2026-09-15|2026-10-31');
    expect(lines.at(-1)).toBe('T|4|3|0|1');
  });

  it('previews what converts and why the rest is rejected, by the issuer file’s own line numbers', async () => {
    const p = await previewMapping(sample, mapping, header);
    expect(p).toMatchObject({ records: 4, converted: 2, rejected: 2, missingColumns: [] });
    expect(p.problems.map((x) => [x.line, x.code])).toEqual([[4, 'eligible_from'], [5, 'card_number']]);
  });
});
