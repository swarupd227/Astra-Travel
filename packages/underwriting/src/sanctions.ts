/**
 * Sanctions screening against the US Treasury OFAC Specially Designated Nationals list (E03-F04-S01).
 * The list is loaded from its published SDN.CSV (and ALT.CSV for aliases): headerless files, "-0-" for
 * an empty value. Only individuals are screened, since travellers are people. Design: docs/adr/0008.
 */

export interface SanctionsEntry {
  uid: string;
  name: string;
  program: string | null;
  aliases: string[];
  /** Dates of birth from the remarks, as given: year, with month and day when the entry has them. */
  births: { year: number; month?: number; day?: number }[];
}

/** Parses CSV text (quotes, doubled quotes, CRLF, newlines inside quoted fields) into rows. */
export function parseCsvRows(text: string): string[][] {
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
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const nil = (v: string | undefined) =>
  v === undefined || v.trim() === '' || v.trim() === '-0-' ? null : v.trim();

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Dates of birth in an SDN remarks field: "DOB 12 Jan 1960", "alt. DOB Jan 1960", "DOB 1960", "DOB circa 1960". */
export function parseBirths(remarks: string | null): SanctionsEntry['births'] {
  if (!remarks) return [];
  const out: SanctionsEntry['births'] = [];
  for (const m of remarks.matchAll(
    /DOB\s+(?:circa\s+)?(?:(\d{1,2})\s+)?(?:([A-Za-z]{3})[a-z]*\s+)?(\d{4})/g,
  )) {
    const month = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0;
    out.push({
      year: Number(m[3]),
      ...(month ? { month } : {}),
      ...(m[1] && month ? { day: Number(m[1]) } : {}),
    });
  }
  return out;
}

export interface ParsedList {
  entries: SanctionsEntry[];
  aliases: number;
  problems: string[];
}

export function parseSdn(sdnCsv: string, altCsv?: string): ParsedList {
  const problems: string[] = [];
  const entries = new Map<string, SanctionsEntry>();
  const rows = parseCsvRows(sdnCsv);
  rows.forEach((r, i) => {
    if (r.length < 4) {
      problems.push(`SDN.CSV row ${i + 1} has ${r.length} columns; the published file has 12.`);
      return;
    }
    const uid = nil(r[0]);
    const name = nil(r[1]);
    if (!uid || !name || !/^\d+$/.test(uid)) {
      problems.push(`SDN.CSV row ${i + 1} has no entry number or name.`);
      return;
    }
    // Only individuals are screened; entities, vessels and aircraft are kept out of the person list.
    if ((nil(r[2]) ?? '').toLowerCase() !== 'individual') return;
    entries.set(uid, {
      uid,
      name,
      program: nil(r[3]),
      aliases: [],
      births: parseBirths(nil(r[11])),
    });
  });
  let aliases = 0;
  if (altCsv) {
    parseCsvRows(altCsv).forEach((r, i) => {
      const uid = nil(r[0]);
      const alias = nil(r[3]);
      if (!uid || !alias) {
        problems.push(`ALT.CSV row ${i + 1} has no entry number or alias.`);
        return;
      }
      const e = entries.get(uid);
      if (e) {
        e.aliases.push(alias);
        aliases++;
      }
    });
  }
  if (rows.length > 0 && entries.size === 0 && problems.length === 0)
    problems.push('The file has no individuals to screen against.');
  return { entries: [...entries.values()], aliases, problems };
}

/** Lower case, accents removed, punctuation dropped, split into words: order and punctuation do not matter. */
export function normaliseName(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array<boolean>(la).fill(false);
  const mb = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(lb, i + range + 1); j++) {
      if (!mb[j] && a[i] === b[j]) {
        ma[i] = mb[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  return (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
}

export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let p = 0;
  while (p < Math.min(4, a.length, b.length) && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

/** How alike two names are, 0 to 1: each word of the shorter name is matched with its best word in the other. */
export function nameScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set<number>();
  let total = 0;
  for (const s of small) {
    let best = 0;
    let at = -1;
    large.forEach((l, i) => {
      if (used.has(i)) return;
      const v = jaroWinkler(s, l);
      if (v > best) {
        best = v;
        at = i;
      }
    });
    if (at >= 0) used.add(at);
    total += best;
  }
  // Extra words (a middle name) cost a little; a single word matching a longer name is weak evidence.
  const extra = large.length - small.length;
  const score = (total / small.length) * (1 - 0.05 * extra);
  return small.length < 2 && large.length >= 2 ? score * 0.8 : score;
}

export interface ScreenedTraveller {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string | undefined;
}

export interface PossibleMatch {
  travellerId: string;
  uid: string;
  name: string;
  program: string | null;
  score: number;
  reason: string;
}

interface Prepared {
  entry: SanctionsEntry;
  names: { text: string; tokens: string[] }[];
}

export class Screener {
  private readonly prepared: Prepared[];
  constructor(entries: SanctionsEntry[]) {
    this.prepared = entries.map((entry) => ({
      entry,
      names: [entry.name, ...entry.aliases].map((text) => ({ text, tokens: normaliseName(text) })),
    }));
  }

  get size() {
    return this.prepared.length;
  }

  screen(travellers: ScreenedTraveller[], threshold: number): PossibleMatch[] {
    const out: PossibleMatch[] = [];
    for (const t of travellers) {
      const tokens = normaliseName(`${t.firstName} ${t.lastName}`);
      const born = t.dateOfBirth
        ? {
            y: Number(t.dateOfBirth.slice(0, 4)),
            m: Number(t.dateOfBirth.slice(5, 7)),
            d: Number(t.dateOfBirth.slice(8, 10)),
          }
        : null;
      for (const p of this.prepared) {
        let best = 0;
        let bestName = p.entry.name;
        for (const n of p.names) {
          // Cheap filter before the full comparison: some word must start alike.
          if (!n.tokens.some((x) => tokens.some((y) => x[0] === y[0]))) continue;
          const s = nameScore(tokens, n.tokens);
          if (s > best) {
            best = s;
            bestName = n.text;
          }
        }
        if (best < threshold - 0.1) continue;
        let score = best;
        let note = `Name resembles ${bestName}`;
        if (born && p.entry.births.length) {
          const agrees = p.entry.births.some(
            (b) =>
              b.year === born.y &&
              (b.month === undefined || b.month === born.m) &&
              (b.day === undefined || b.day === born.d),
          );
          if (agrees) {
            score = Math.min(1, score + 0.05);
            note += '; date of birth agrees';
          } else {
            score *= 0.8;
            note += '; date of birth differs';
          }
        }
        if (score >= threshold)
          out.push({
            travellerId: t.id,
            uid: p.entry.uid,
            name: p.entry.name,
            program: p.entry.program,
            score: Math.round(score * 1000) / 1000,
            reason: note,
          });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }
}
