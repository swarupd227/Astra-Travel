import { describe, expect, it } from 'vitest';
import { findBrackets, suggest } from './brackets';
import { extractText, UnreadableDocumentError } from './pdf-text';
import { coerceRow, diffEntries, parseCsv, validateEntries } from './refdata';
import { checkLocation, pageOf } from './text';
import { checkValue } from './variables';

/**
 * The bracketed examples below are quoted from the product specification (M1, "How variable forms are
 * modelled"), which quotes the filed VSC form and schedule. They are the only form wording we hold.
 */
const SPEC_WORDING = [
  'You may cancel within the [ten (10) - fifteen (15)] day review period.',
  'We will reimburse [twenty-five percent (25%) – one hundred percent (100%)] of the Trip Cost.',
  'Trip Cancellation maximum per person [$0-$5,000,000].',
  '[[Optional] Trip Delay maximum [$100-$10,000] per person]',
  'cancel your [cruise][tour][trip] arrangements',
  'no later than [twenty-four (24) – one hundred sixty-eight (168) hours] before departure',
  'Maximum Benefit [PER PERSON] [PER TRIP] and [PER RESERVATION] [PER POLICY].',
  'We do not cover travel to <<insert list of countries>>. See <<insert website>>.',
].join('\n');

describe('bracket finder', () => {
  const found = findBrackets(SPEC_WORDING);
  const by = (text: string) => found.find((f) => f.text === text);

  it('reads the review period as a time period in days', () => {
    expect(by('[ten (10) - fifteen (15)]')?.suggestion).toMatchObject({
      type: 'time_period',
      constraints: { min: 10, max: 15, unit: 'days' },
    });
  });

  it('reads a written-out percentage range', () => {
    expect(
      by('[twenty-five percent (25%) – one hundred percent (100%)]')?.suggestion,
    ).toMatchObject({
      type: 'percentage_range',
      constraints: { min: 25, max: 100 },
    });
  });

  it('reads dollar ranges with thousands separators', () => {
    expect(by('[$0-$5,000,000]')?.suggestion).toMatchObject({
      type: 'numeric_range',
      constraints: { min: 0, max: 5_000_000, unit: 'usd' },
    });
    expect(by('[$100-$10,000]')?.suggestion).toMatchObject({
      type: 'numeric_range',
      constraints: { min: 100, max: 10_000 },
    });
  });

  it('finds an optional benefit with a nested range, but not the [Optional] marker itself', () => {
    const optional = by('[[Optional] Trip Delay maximum [$100-$10,000] per person]');
    expect(optional).toMatchObject({ depth: 0, suggestion: { type: 'optional_benefit' } });
    expect(by('[$100-$10,000]')?.depth).toBe(1);
    expect(by('[Optional]')).toBeUndefined();
  });

  it('groups adjacent alternatives into one choice or limit basis', () => {
    expect(by('[cruise][tour][trip]')?.suggestion).toMatchObject({
      type: 'wording_choice',
      constraints: { options: ['cruise', 'tour', 'trip'], multiple: true },
    });
    expect(by('[PER PERSON] [PER TRIP]')?.suggestion).toMatchObject({
      type: 'limit_basis',
      constraints: { options: ['PER PERSON', 'PER TRIP'] },
    });
    expect(by('[PER RESERVATION] [PER POLICY]')?.suggestion?.type).toBe('limit_basis');
  });

  it('reads the hours of the CFAR cancellation window', () => {
    expect(
      by('[twenty-four (24) – one hundred sixty-eight (168) hours]')?.suggestion,
    ).toMatchObject({
      type: 'time_period',
      constraints: { min: 24, max: 168, unit: 'hours' },
    });
  });

  it('links placeholders to reference data or to a URL', () => {
    expect(by('<<insert list of countries>>')?.suggestion).toMatchObject({
      type: 'insert_placeholder',
      constraints: { source: 'dataset', dataset: 'prohibited_destinations' },
    });
    expect(by('<<insert website>>')?.suggestion).toMatchObject({ constraints: { source: 'url' } });
  });

  it('gives offsets that point at the exact text', () => {
    for (const f of found) expect(SPEC_WORDING.slice(f.start, f.end)).toBe(f.text);
  });

  it('does not guess when the wording is not a clear range', () => {
    expect(suggest('the Insured')).toBeNull();
    expect(suggest('$500 per day')).toBeNull();
  });

  it('ignores unmatched brackets', () => {
    expect(findBrackets('a ] b [ c')).toEqual([]);
  });
});

describe('text locations', () => {
  it('maps offsets to pages', () => {
    expect(pageOf([0, 100, 250], 0)).toBe(1);
    expect(pageOf([0, 100, 250], 100)).toBe(2);
    expect(pageOf([0, 100, 250], 9999)).toBe(3);
  });

  it('only accepts an excerpt that matches the text', () => {
    expect(checkLocation('abc [x] def', 4, 7, '[x]')).toBeNull();
    expect(checkLocation('abc [x] def', 4, 7, '[y]')).toMatch(/does not match/);
    expect(checkLocation('abc', 2, 9, 'c')).toMatch(/outside/);
  });
});

describe('variable values against filed ranges', () => {
  it('rejects values outside a numeric range', () => {
    const v = {
      label: 'Trip Delay maximum',
      type: 'numeric_range' as const,
      constraints: { min: 100, max: 10_000, unit: 'usd' },
    };
    expect(checkValue(v, 100)).toEqual({ ok: true });
    expect(checkValue(v, 10_001)).toMatchObject({
      ok: false,
      message: expect.stringContaining('between 100 and 10000'),
    });
    expect(checkValue(v, '500')).toMatchObject({ ok: false });
  });

  it('checks percentage and basis', () => {
    const v = {
      label: 'CFAR',
      type: 'percentage_range' as const,
      constraints: { min: 25, max: 100, bases: ['air cost', 'trip cost'] },
    };
    expect(checkValue(v, { percent: 75, basis: 'trip cost' }).ok).toBe(true);
    expect(checkValue(v, { percent: 75, basis: 'hotel cost' }).ok).toBe(false);
    expect(checkValue(v, { percent: 20, basis: 'trip cost' }).ok).toBe(false);
  });

  it('allows only filed wording, never free text', () => {
    const v = {
      label: 'Arrangements',
      type: 'wording_choice' as const,
      constraints: { options: ['cruise', 'tour', 'trip'], multiple: true },
    };
    expect(checkValue(v, ['cruise', 'trip']).ok).toBe(true);
    expect(checkValue(v, ['ferry']).ok).toBe(false);
    expect(checkValue(v, []).ok).toBe(false);
    expect(
      checkValue({ ...v, constraints: { ...v.constraints, multiple: false } }, ['cruise', 'trip'])
        .ok,
    ).toBe(false);
  });

  it('checks time periods, limit bases, optional benefits and placeholders', () => {
    expect(
      checkValue(
        { label: 'Review', type: 'time_period', constraints: { min: 10, max: 15, unit: 'days' } },
        9,
      ).ok,
    ).toBe(false);
    expect(
      checkValue(
        {
          label: 'Basis',
          type: 'limit_basis',
          constraints: { options: ['PER PERSON', 'PER TRIP'] },
        },
        'PER TRIP',
      ).ok,
    ).toBe(true);
    expect(
      checkValue({ label: 'Trip Delay', type: 'optional_benefit', constraints: {} }, 'yes').ok,
    ).toBe(false);
    const url = {
      label: 'Website',
      type: 'insert_placeholder' as const,
      constraints: { source: 'url' },
    };
    expect(checkValue(url, 'https://example.com/travel').ok).toBe(true);
    expect(checkValue(url, 'http://example.com').ok).toBe(false);
    expect(
      checkValue(
        {
          label: 'Countries',
          type: 'insert_placeholder',
          constraints: { source: 'dataset', dataset: 'prohibited_destinations' },
        },
        null,
      ).ok,
    ).toBe(true);
  });
});

describe('form text extraction', () => {
  it('reads plain text with form-feed page breaks', async () => {
    const t = await extractText(new TextEncoder().encode('page one\r\n\fpage two'), 'text/plain');
    expect(t).toEqual({ text: 'page one\n\fpage two', pageStarts: [0, 10] });
  });

  it('reads the text of a PDF, page by page', async () => {
    const t = await extractText(
      pdf(['Review period [ten (10) - fifteen (15)] days', 'Second page']),
      'application/pdf',
    );
    expect(t.text).toContain('[ten (10) - fifteen (15)]');
    expect(t.pageStarts).toHaveLength(2);
    expect(t.text.slice(t.pageStarts[1])).toContain('Second page');
  });

  it('refuses a file that is not a readable PDF', async () => {
    await expect(
      extractText(new TextEncoder().encode('not a pdf'), 'application/pdf'),
    ).rejects.toBeInstanceOf(UnreadableDocumentError);
  });
});

describe('reference data', () => {
  it('parses CSV with quotes and CRLF', () => {
    expect(parseCsv('code,name\r\n"NY","New York, ""Empire"""\r\nCA,California\r\n')).toEqual([
      { code: 'NY', name: 'New York, "Empire"' },
      { code: 'CA', name: 'California' },
    ]);
    expect(() => parseCsv('a,b\n1')).toThrow(/Row 2/);
  });

  it('coerces CSV text to the dataset field types', () => {
    expect(
      coerceRow('destination_regions', {
        code: 'EUR',
        name: 'Europe',
        scope: 'international',
        countries: 'FR; DE',
      }),
    ).toEqual({
      code: 'EUR',
      name: 'Europe',
      scope: 'international',
      countries: ['FR', 'DE'],
    });
    expect(
      coerceRow('premium_tax_rates', {
        key: 'NY:VSC',
        state: 'NY',
        insurer: 'VSC',
        ratePercent: '2',
        basis: 'b',
        notes: '',
      }),
    ).toMatchObject({ ratePercent: 2 });
  });

  it('validates entries, rejects unknown fields and repeated keys, and hashes the content', () => {
    const v = validateEntries('us_states', [
      { code: 'NY', name: 'New York', kind: 'state' },
      { code: 'NY', name: 'New York again', kind: 'state' },
      { code: 'ny', name: 'Lower case', kind: 'state' },
      { code: 'DC', name: 'District of Columbia', kind: 'district', extra: 1 },
    ]);
    expect(v.entries.map((e) => e.key)).toEqual(['NY']);
    expect(v.problems.map((p) => [p.row, p.field])).toEqual([
      [2, 'code'],
      [3, 'code'],
      [4, '(row)'],
    ]);
    const a = validateEntries('us_states', [
      { code: 'CA', name: 'California', kind: 'state' },
      { code: 'NY', name: 'New York', kind: 'state' },
    ]);
    const b = validateEntries('us_states', [
      { code: 'NY', name: 'New York', kind: 'state' },
      { code: 'CA', name: 'California', kind: 'state' },
    ]);
    expect(a.sha256).toBe(b.sha256);
  });

  it('checks the key format of premium tax rates', () => {
    const v = validateEntries('premium_tax_rates', [
      { key: 'NY:ABIC', state: 'NY', insurer: 'VSC', ratePercent: 2, basis: 'gross premium' },
    ]);
    expect(v.problems[0]?.field).toBe('key');
  });

  it('diffs two versions', () => {
    const before = new Map([
      ['NY', { name: 'New York' }],
      ['CA', { name: 'California' }],
      ['TX', { name: 'Texas' }],
    ]);
    const after = new Map([
      ['NY', { name: 'New York' }],
      ['CA', { name: 'California (CA)' }],
      ['FL', { name: 'Florida' }],
    ]);
    expect(diffEntries(before, after)).toEqual({
      added: ['FL'],
      removed: ['TX'],
      changed: ['CA'],
      unchanged: 1,
    });
  });
});

/** A minimal, valid PDF with one line of Helvetica text per page (built here so the test owns its input). */
function pdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((p, i) => {
    const content = `BT /F1 12 Tf 72 720 Td (${p.replace(/([()\\])/g, '\\$1')}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
    );
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
