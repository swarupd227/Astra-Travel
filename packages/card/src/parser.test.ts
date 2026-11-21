import { describe, expect, it } from 'vitest';
import { addDays, evaluatePayment } from './cover';
import {
  isRealDate,
  looksLikeCardNumber,
  parseFeed,
  type FeedRecord,
  type RecordRejection,
} from './parser';

async function* lines(text: string) {
  if (text === '') return; // readline yields no lines for an empty file
  for (const l of text.split('\n')) yield l;
}

async function parse(text: string) {
  const records: FeedRecord[] = [];
  const rejections: RecordRejection[] = [];
  const result = await parseFeed(lines(text), {
    record: (r) => void records.push(r),
    reject: (r) => void rejections.push(r),
  });
  return { ...result, records, rejections };
}

const H = 'H|ASTRA-ELIG|1|SWANBANK-TRAVEL|1|FULL|2026-12-01';

describe('eligibility feed parser', () => {
  it('parses a valid full feed, tolerating CRLF and a final newline', async () => {
    const r = await parse(
      `${H}\r\nD|tok_8f2a91c0|PLAT|A|2026-01-15|\r\nD|tok_77b0e4d2|GOLD|A|2025-06-01|2027-05-31\r\nT|2|2|0|0\r\n`,
    );
    expect(r.fatal).toEqual([]);
    expect(r.header).toEqual({
      programmeCode: 'SWANBANK-TRAVEL',
      sequence: 1,
      kind: 'FULL',
      asOfDate: '2026-12-01',
    });
    expect(r.records).toEqual([
      {
        lineNo: 2,
        accountRef: 'tok_8f2a91c0',
        productCode: 'PLAT',
        action: 'A',
        eligibleFrom: '2026-01-15',
        eligibleTo: null,
      },
      {
        lineNo: 3,
        accountRef: 'tok_77b0e4d2',
        productCode: 'GOLD',
        action: 'A',
        eligibleFrom: '2025-06-01',
        eligibleTo: '2027-05-31',
      },
    ]);
  });

  it('rejects card numbers without keeping the value', async () => {
    const r = await parse(
      `${H}\nD|4111111111111111|PLAT|A|2026-01-15|\nD|4111-1111-1111-1111|PLAT|A|2026-01-15|\nT|2|2|0|0`,
    );
    expect(r.fatal).toEqual([]);
    expect(r.records).toHaveLength(0);
    expect(r.rejections.map((x) => [x.code, x.accountRef])).toEqual([
      ['card_number', null],
      ['card_number', null],
    ]);
    expect(JSON.stringify(r.rejections)).not.toContain('4111');
  });

  it('rejects bad records individually', async () => {
    const r = await parse(
      [
        'H|ASTRA-ELIG|1|SWANBANK-TRAVEL|2|CHANGE|2026-12-02',
        'D|tok_a1|PLAT|X|2026-01-01|',
        'D|tok_a2|PLAT|A|2026-02-30|',
        'D|tok_a3|PLAT|U|2026-03-01|2026-02-01',
        'D|tok_a4|PLAT|D|2026-03-01',
        'D|ab|PLAT|A|2026-03-01|',
        'D|tok_a5||A|2026-03-01|',
        'D|tok_a6|PLAT|D|2026-03-01|2026-12-31',
        'T|7|3|1|2',
      ].join('\n'),
    );
    expect(r.fatal).toEqual([]);
    expect(r.rejections.map((x) => x.code)).toEqual([
      'action',
      'eligible_from',
      'eligible_to',
      'field_count',
      'account_ref',
      'product_code',
    ]);
    expect(r.records.map((x) => x.accountRef)).toEqual(['tok_a6']);
  });

  it('only accepts A records in a full feed', async () => {
    const r = await parse(`${H}\nD|tok_a1|PLAT|U|2026-01-01|\nT|1|0|1|0`);
    expect(r.rejections[0]?.code).toBe('action');
  });

  it.each([
    ['', 'The file is empty'],
    ['X|nope', 'does not start with an ASTRA-ELIG header'],
    ['H|ASTRA-ELIG|2|SWANBANK-TRAVEL|1|FULL|2026-12-01\nT|0|0|0|0', 'format version 2'],
    [
      'H|ASTRA-ELIG|1|SWANBANK-TRAVEL|0|FULL|2026-12-01\nT|0|0|0|0',
      'sequence must be a positive integer',
    ],
    ['H|ASTRA-ELIG|1|SWANBANK-TRAVEL|1|DELTA|2026-12-01\nT|0|0|0|0', 'kind must be FULL or CHANGE'],
    [`${H}\nD|tok_a1|PLAT|A|2026-01-01|`, 'no trailer'],
    [`${H}\nD|tok_a1|PLAT|A|2026-01-01|\nT|2|2|0|0`, 'the trailer says 2 records, the file has 1'],
    [`${H}\nD|tok_a1|PLAT|A|2026-01-01|\nT|1|0|1|0`, 'adds/updates/removes'],
    [`${H}\nT|0|0|0|0\nD|tok_a1|PLAT|A|2026-01-01|`, 'data after the trailer'],
    [`${H}\nZ|what`, 'unknown record type'],
    [`${H}\n\nT|0|0|0|0`, 'empty line'],
  ])('holds structurally broken files: %j', async (text, message) => {
    const r = await parse(text);
    expect(r.fatal.join(' ')).toContain(message);
  });

  it('counts records with bad actions against the control totals', async () => {
    // A record with an unknown action is still a detail record; it is not an add, update or remove.
    const r = await parse(`${H}\nD|tok_a1|PLAT|Q|2026-01-01|\nT|1|0|0|0`);
    expect(r.fatal).toEqual([]);
    expect(r.rejected).toBe(1);
  });
});

describe('helpers', () => {
  it('recognises real dates only', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2027-02-29')).toBe(false);
    expect(isRealDate('2027-1-01')).toBe(false);
  });

  it('treats Luhn-valid 13 to 19 digit references as card numbers', () => {
    expect(looksLikeCardNumber('4111111111111111')).toBe(true);
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('4111111111111112')).toBe(false);
    expect(looksLikeCardNumber('123456789012')).toBe(false);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('payment condition', () => {
  it('needs nothing when there is no condition', () => {
    expect(evaluatePayment({ rule: 'none' }, undefined).met).toBe(true);
  });

  it('cannot be decided without payment details', () => {
    expect(evaluatePayment({ rule: 'full' }, undefined).met).toBeNull();
  });

  it('checks full and partial payment at the boundary, in cents', () => {
    expect(
      evaluatePayment({ rule: 'full' }, { tripCost: 1234.56, amountPaidWithAccount: 1234.56 }).met,
    ).toBe(true);
    expect(
      evaluatePayment({ rule: 'full' }, { tripCost: 1234.56, amountPaidWithAccount: 1234.55 }).met,
    ).toBe(false);
    expect(
      evaluatePayment(
        { rule: 'partial', minimumPercent: 50 },
        { tripCost: 0.3, amountPaidWithAccount: 0.15 },
      ).met,
    ).toBe(true);
    expect(
      evaluatePayment(
        { rule: 'partial', minimumPercent: 50 },
        { tripCost: 1000, amountPaidWithAccount: 499.99 },
      ).met,
    ).toBe(false);
  });

  it('refuses a payment larger than the trip cost', () => {
    expect(() =>
      evaluatePayment({ rule: 'full' }, { tripCost: 10, amountPaidWithAccount: 11 }),
    ).toThrow(/cannot exceed/);
  });
});
