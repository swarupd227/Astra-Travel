import type { FeedMappingDocument } from '@astra/contracts';
import {
  isRealDate,
  looksLikeCardNumber,
  parseFeed,
  type FeedRecord,
  type RecordRejection,
} from './parser';

/**
 * Turns an issuer's own delimited file into the eligibility feed format (E21-F04-S01), so the one parser and its
 * controls apply to every feed. Nothing is guessed: a value that cannot be converted is passed through as written, so
 * the parser rejects that record with its reason. Design: docs/adr/0021.
 */

/** The standard test card number: it stands in for a real one, so the record is still rejected as a card number. */
const CARD_STAND_IN = '4111111111111111';

/** Splits one line into fields; a field may be quoted, with doubled quotes inside. */
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Removes anything that looks like a payment card number before text is stored or shown to anyone. */
export function maskCardNumbers(text: string): { text: string; removed: number } {
  let removed = 0;
  const masked = text.replace(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g, (m) => {
    if (!looksLikeCardNumber(m)) return m;
    removed += 1;
    return CARD_STAND_IN;
  });
  return { text: masked, removed };
}

export function convertDate(value: string, format: string): string | null {
  const m =
    format === 'YYYY-MM-DD'
      ? /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})$/.exec(value)
      : format === 'YYYYMMDD'
        ? /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/.exec(value)
        : format === 'MM/DD/YYYY'
          ? /^(?<m>\d{1,2})\/(?<d>\d{1,2})\/(?<y>\d{4})$/.exec(value)
          : /^(?<d>\d{1,2})\/(?<m>\d{1,2})\/(?<y>\d{4})$/.exec(value);
  if (!m?.groups) return null;
  const iso = `${m.groups.y}-${m.groups.m!.padStart(2, '0')}-${m.groups.d!.padStart(2, '0')}`;
  return isRealDate(iso) ? iso : null;
}

export interface ConvertHeader {
  programmeCode: string;
  sequence: number;
  kind: 'FULL' | 'CHANGE';
  asOfDate: string;
}

const columnsOf = (m: FeedMappingDocument): string[] => {
  const c = m.columns;
  return [
    c.accountRef.column,
    ...('column' in c.productCode ? [c.productCode.column] : []),
    ...('column' in c.action ? [c.action.column] : []),
    c.eligibleFrom.column,
    ...(c.eligibleTo ? [c.eligibleTo.column] : []),
  ];
};

/** The columns the mapping needs that the file's first line does not have. */
export function missingColumns(headerLine: string, m: FeedMappingDocument): string[] {
  const names = new Set(
    splitLine(headerLine.replace(/^\uFEFF/, '').replace(/\r$/, ''), m.delimiter),
  );
  return [...new Set(columnsOf(m))].filter((c) => !names.has(c));
}

/**
 * Converts the issuer's lines (the first naming the columns) to feed lines. Throws when a needed column is missing.
 * Detail line n of the result comes from line n of the issuer's file, so rejections point at the issuer's own lines.
 */
export async function* convertLines(
  lines: AsyncIterable<string> | Iterable<string>,
  m: FeedMappingDocument,
  h: ConvertHeader,
): AsyncGenerator<string> {
  let index: Map<string, number> | null = null;
  let count = 0;
  const actions = { A: 0, U: 0, D: 0 };
  const safe = (v: string) => v.replace(/[|\r\n]/g, '?');
  for await (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (index === null) {
      const missing = missingColumns(line, m);
      if (missing.length) throw new Error(`The file has no column ${missing.join(', ')}.`);
      index = new Map(
        splitLine(line.replace(/^\uFEFF/, ''), m.delimiter).map((name, i) => [name, i]),
      );
      yield `H|ASTRA-ELIG|1|${h.programmeCode}|${h.sequence}|${h.kind}|${h.asOfDate}`;
      continue;
    }
    if (line.trim() === '') continue;
    const fields = splitLine(line, m.delimiter);
    const at = (col: string) => fields[index!.get(col)!] ?? '';
    const c = m.columns;
    const rawRef = at(c.accountRef.column);
    const ref = looksLikeCardNumber(rawRef) ? CARD_STAND_IN : rawRef;
    const product =
      'constant' in c.productCode
        ? c.productCode.constant
        : (c.productCode.values[at(c.productCode.column)] ?? at(c.productCode.column));
    const action =
      'constant' in c.action
        ? c.action.constant
        : (c.action.values[at(c.action.column)] ?? at(c.action.column));
    const date = (spec: { column: string; format: string }) => {
      const v = at(spec.column);
      return v === '' ? '' : (convertDate(v, spec.format) ?? `unreadable:${v}`);
    };
    count += 1;
    if (action === 'A' || action === 'U' || action === 'D') actions[action] += 1;
    yield `D|${safe(ref)}|${safe(product)}|${safe(action)}|${safe(date(c.eligibleFrom))}|${c.eligibleTo ? safe(date(c.eligibleTo)) : ''}`;
  }
  if (index === null) throw new Error('The file is empty.');
  yield `T|${count}|${actions.A}|${actions.U}|${actions.D}`;
}

/** What a mapping makes of a sample: what converts, what the feed rules reject, and why. */
export async function previewMapping(sample: string, m: FeedMappingDocument, h: ConvertHeader) {
  const lines = sample.split('\n');
  const missing = missingColumns(lines[0] ?? '', m);
  if (missing.length)
    return {
      missingColumns: missing,
      records: 0,
      converted: 0,
      rejected: 0,
      sample: [],
      problems: [],
    };
  const records: FeedRecord[] = [];
  const rejections: RecordRejection[] = [];
  const result = await parseFeed(convertLines(lines, m, h), {
    record: (r) => void records.push(r),
    reject: (r) => void rejections.push(r),
  });
  return {
    missingColumns: [],
    records: result.detailRecords,
    converted: records.length,
    rejected: rejections.length,
    sample: records.slice(0, 10).map((r) => ({
      line: r.lineNo,
      accountRef: r.accountRef,
      productCode: r.productCode,
      action: r.action,
      eligibleFrom: r.eligibleFrom,
      eligibleTo: r.eligibleTo,
    })),
    problems: rejections
      .slice(0, 50)
      .map((r) => ({ line: r.lineNo, code: r.code, message: r.message })),
  };
}
