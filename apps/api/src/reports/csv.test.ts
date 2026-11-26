import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('report CSV', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', 3]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",3\r\n');
  });

  it('stops a spreadsheet running a cell as a formula, without touching amounts', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('-84.00')).toBe('-84.00');
    expect(csvCell('--')).toBe('--');
    expect(csvCell(null)).toBe('');
  });
});
