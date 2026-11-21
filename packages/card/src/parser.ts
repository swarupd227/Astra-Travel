/**
 * Parser for eligibility feed format v1 (docs/integration/eligibility-feed-v1.md). Streams line by line,
 * so feeds of tens of millions of records never sit in memory. Problems with a single record reject that
 * record; problems with the file's structure or control totals are fatal and hold the whole feed.
 */

export interface FeedHeader {
  programmeCode: string;
  sequence: number;
  kind: 'FULL' | 'CHANGE';
  asOfDate: string;
}

export interface FeedRecord {
  lineNo: number;
  accountRef: string;
  productCode: string;
  action: 'A' | 'U' | 'D';
  eligibleFrom: string;
  /** Last eligible day, inclusive. */
  eligibleTo: string | null;
}

export interface RecordRejection {
  lineNo: number;
  /** Never set when the reference looked like a card number. */
  accountRef: string | null;
  code: string;
  message: string;
}

export interface ParseResult {
  header: FeedHeader | null;
  detailRecords: number;
  rejected: number;
  /** Structural or control-total problems: the feed must be held. */
  fatal: string[];
}

const ACCOUNT_REF = /^[A-Za-z0-9._-]{4,64}$/;
const PRODUCT = /^[A-Za-z0-9._-]{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A reference that is all digits, 13 to 19 long and Luhn-valid is treated as a payment card number. */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[ -]/g, '');
  return /^\d{13,19}$/.test(digits) && luhnValid(digits);
}

export interface ParseSink {
  record(r: FeedRecord): Promise<void> | void;
  reject(r: RecordRejection): Promise<void> | void;
}

export async function parseFeed(
  lines: AsyncIterable<string>,
  sink: ParseSink,
): Promise<ParseResult> {
  const fatal: string[] = [];
  let header: FeedHeader | null = null;
  let trailer: { count: number; adds: number; updates: number; removes: number } | null = null;
  let lineNo = 0;
  let detail = 0;
  let rejected = 0;
  const actions = { A: 0, U: 0, D: 0 };

  const reject = async (r: RecordRejection) => {
    rejected += 1;
    await sink.reject(r);
  };

  for await (const raw of lines) {
    lineNo += 1;
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      if (trailer) continue; // tolerate a trailing newline
      fatal.push(`Line ${lineNo}: empty line`);
      continue;
    }
    if (trailer) {
      fatal.push(`Line ${lineNo}: data after the trailer`);
      break;
    }
    const f = line.split('|');
    const type = f[0];

    if (lineNo === 1) {
      if (type !== 'H' || f.length !== 7 || f[1] !== 'ASTRA-ELIG') {
        fatal.push('Line 1: the file does not start with an ASTRA-ELIG header');
        break;
      }
      if (f[2] !== '1') {
        fatal.push(`Line 1: format version ${f[2]} is not supported`);
        break;
      }
      const sequence = Number(f[4]);
      const kind = f[5];
      const asOf = f[6] ?? '';
      if (!Number.isInteger(sequence) || sequence < 1)
        fatal.push('Line 1: sequence must be a positive integer');
      if (kind !== 'FULL' && kind !== 'CHANGE') fatal.push('Line 1: kind must be FULL or CHANGE');
      if (!isRealDate(asOf)) fatal.push('Line 1: as-of date must be a real YYYY-MM-DD date');
      if (fatal.length) break;
      header = {
        programmeCode: f[3] ?? '',
        sequence,
        kind: kind as 'FULL' | 'CHANGE',
        asOfDate: asOf,
      };
      continue;
    }

    if (type === 'T') {
      const nums = f.slice(1).map(Number);
      if (f.length !== 5 || nums.some((n) => !Number.isInteger(n) || n < 0)) {
        fatal.push(`Line ${lineNo}: the trailer must be T|count|adds|updates|removes`);
        break;
      }
      trailer = { count: nums[0]!, adds: nums[1]!, updates: nums[2]!, removes: nums[3]! };
      continue;
    }

    if (type !== 'D') {
      fatal.push(`Line ${lineNo}: unknown record type ${JSON.stringify(type?.slice(0, 3) ?? '')}`);
      break;
    }

    detail += 1;
    const [, ref = '', product = '', action = '', from = '', to = ''] = f;
    if (action === 'A' || action === 'U' || action === 'D') actions[action] += 1;

    if (f.length !== 6) {
      await reject({
        lineNo,
        accountRef: null,
        code: 'field_count',
        message: 'A detail record has 6 fields.',
      });
      continue;
    }
    if (looksLikeCardNumber(ref)) {
      await reject({
        lineNo,
        accountRef: null,
        code: 'card_number',
        message:
          'The account reference looks like a card number. Send the issuer token instead; the value was not stored.',
      });
      continue;
    }
    if (!ACCOUNT_REF.test(ref)) {
      await reject({
        lineNo,
        accountRef: null,
        code: 'account_ref',
        message: 'The account reference must be 4 to 64 letters, digits, ".", "_" or "-".',
      });
      continue;
    }
    if (!PRODUCT.test(product)) {
      await reject({
        lineNo,
        accountRef: ref,
        code: 'product_code',
        message: 'The product code must be 1 to 32 letters, digits, ".", "_" or "-".',
      });
      continue;
    }
    if (action !== 'A' && action !== 'U' && action !== 'D') {
      await reject({
        lineNo,
        accountRef: ref,
        code: 'action',
        message: 'The action must be A, U or D.',
      });
      continue;
    }
    if (header?.kind === 'FULL' && action !== 'A') {
      await reject({
        lineNo,
        accountRef: ref,
        code: 'action',
        message: 'A full feed only contains A records.',
      });
      continue;
    }
    if (!isRealDate(from)) {
      await reject({
        lineNo,
        accountRef: ref,
        code: 'eligible_from',
        message: 'Eligible-from must be a real YYYY-MM-DD date.',
      });
      continue;
    }
    if (to !== '' && (!isRealDate(to) || to < from)) {
      await reject({
        lineNo,
        accountRef: ref,
        code: 'eligible_to',
        message: 'Eligible-to must be a real date on or after eligible-from.',
      });
      continue;
    }
    await sink.record({
      lineNo,
      accountRef: ref,
      productCode: product,
      action,
      eligibleFrom: from,
      eligibleTo: to || null,
    });
  }

  if (!header && !fatal.length) fatal.push('The file is empty');
  if (header && !trailer && !fatal.length)
    fatal.push('The file has no trailer: it may be incomplete');
  if (trailer) {
    if (trailer.count !== detail) {
      fatal.push(
        `Control total: the trailer says ${trailer.count} records, the file has ${detail}`,
      );
    }
    if (
      trailer.adds !== actions.A ||
      trailer.updates !== actions.U ||
      trailer.removes !== actions.D
    ) {
      fatal.push(
        `Control total: the trailer says ${trailer.adds}/${trailer.updates}/${trailer.removes} adds/updates/removes, the file has ${actions.A}/${actions.U}/${actions.D}`,
      );
    }
  }
  return { header, detailRecords: detail, rejected, fatal };
}
