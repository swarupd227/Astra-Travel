import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { REFDATA_DATASETS, type RefdataDataset } from '@astra/contracts';
import { canonicalJson } from '@astra/platform';

/** Loading, validating and comparing reference data versions (E16-F01-S02). */

export interface EntryProblem {
  row: number;
  field: string;
  message: string;
}

export interface ValidatedEntries {
  entries: { key: string; data: Record<string, unknown> }[];
  problems: EntryProblem[];
  sha256: string;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF line ends. The first row names the fields. */
export function parseCsv(input: string): Record<string, string>[] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new Error('The file ends inside a quoted field.');
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => h.trim());
  if (new Set(header).size !== header.length) throw new Error('The header has a repeated column.');
  return rows.slice(1).map((r, n) => {
    if (r.length !== header.length)
      throw new Error(`Row ${n + 2} has ${r.length} fields; the header has ${header.length}.`);
    return Object.fromEntries(header.map((h, k) => [h, r[k]!.trim()]));
  });
}

function shapeOf(dataset: RefdataDataset): Record<string, z.ZodType> {
  const entry = REFDATA_DATASETS[dataset].entry as z.ZodType;
  // A refined object keeps its shape in the inner type.
  const obj =
    (entry as unknown as { shape?: Record<string, z.ZodType> }).shape ??
    (
      entry as unknown as {
        def: {
          in?: { shape: Record<string, z.ZodType> };
          schema?: { shape: Record<string, z.ZodType> };
        };
      }
    ).def.in?.shape ??
    (entry as unknown as { def: { schema?: { shape: Record<string, z.ZodType> } } }).def.schema
      ?.shape;
  if (!obj) throw new Error(`No object shape for ${dataset}`);
  return obj;
}

export function datasetFields(dataset: RefdataDataset): string[] {
  return Object.keys(shapeOf(dataset));
}

function baseType(t: z.ZodType): string {
  let s = t as unknown as { def: { type: string; innerType?: z.ZodType } };
  while (s.def.type === 'optional' || s.def.type === 'nullable' || s.def.type === 'default') {
    s = s.def.innerType as unknown as typeof s;
  }
  return s.def.type;
}

/** CSV values are text: numbers become numbers, lists are separated by `;`, empty optional fields are left out. */
export function coerceRow(
  dataset: RefdataDataset,
  row: Record<string, string>,
): Record<string, unknown> {
  const shape = shapeOf(dataset);
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(row)) {
    const t = shape[k];
    if (!t) {
      out[k] = raw;
      continue;
    }
    if (raw === '') continue;
    const kind = baseType(t);
    if (kind === 'number') out[k] = Number(raw);
    else if (kind === 'array')
      out[k] = raw
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean);
    else out[k] = raw;
  }
  return out;
}

export function validateEntries(
  dataset: RefdataDataset,
  rows: Record<string, unknown>[],
): ValidatedEntries {
  const def = REFDATA_DATASETS[dataset];
  const schema = (def.entry as unknown as z.ZodObject).strict
    ? (def.entry as unknown as z.ZodObject).strict()
    : def.entry;
  const problems: EntryProblem[] = [];
  const entries: ValidatedEntries['entries'] = [];
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const parsed = (schema as z.ZodType).safeParse(row);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({
          row: i + 1,
          field: issue.path.join('.') || '(row)',
          message: issue.message,
        });
      }
      return;
    }
    const data = parsed.data as Record<string, unknown>;
    const key = String(data[def.keyField]);
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push({
        row: i + 1,
        field: def.keyField,
        message: `Repeats ${key} from row ${first}.`,
      });
      return;
    }
    seen.set(key, i + 1);
    entries.push({ key, data });
  });
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const sha256 = createHash('sha256').update(canonicalJson(entries)).digest('hex');
  return { entries, problems, sha256 };
}

export function diffEntries(
  before: Map<string, Record<string, unknown>>,
  after: Map<string, Record<string, unknown>>,
): { added: string[]; removed: string[]; changed: string[]; unchanged: number } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [k, v] of after) {
    const prev = before.get(k);
    if (!prev) added.push(k);
    else if (canonicalJson(prev) !== canonicalJson(v)) changed.push(k);
    else unchanged++;
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged };
}
