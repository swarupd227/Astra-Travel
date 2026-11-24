import Decimal from 'decimal.js';
import type { ManualDocument } from '@astra/contracts';

/**
 * Checks a drafted manual against the text of the filed document (E02-F01-S02): each table's page must be
 * found in the document, and each factor must appear as a number on that page. This shows where a draft
 * disagrees with the filed page; it does not replace the rating analyst's comparison.
 */

export interface PageText {
  /** 1-based page number in the document. */
  page: number;
  text: string;
}

export function splitPages(text: string, pageStarts: readonly number[]): PageText[] {
  const starts = pageStarts.length ? pageStarts : [0];
  return starts.map((s, i) => ({ page: i + 1, text: text.slice(s, starts[i + 1] ?? text.length) }));
}

export interface TableCheck {
  tableId: string;
  /** The page label the draft gives, as the manual prints it. */
  pageLabel: string;
  /** The document page the label was found on, or null. */
  documentPage: number | null;
  rows: number;
  factorsFound: number;
  /** Factors (and the keys of their rows) not found as numbers on the page. */
  missing: string[];
  ok: boolean;
  detail: string;
}

const canonical = (s: string): string | null => {
  try {
    return new Decimal(s.replace(/,/g, '')).toString();
  } catch {
    return null;
  }
};

/** Every number on a page, in canonical form: 0.7200, 0.72 and .72 are the same number. */
export function numbersOn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.])-?(?:\d[\d,]*)?\.?\d+(?![\w])/g)) {
    const c = canonical(m[0].startsWith('.') ? `0${m[0]}` : m[0]);
    if (c) out.add(c);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** The document page a table's page label belongs to: the page that prints the label, else the label's own number. */
export function locatePage(label: string, pages: PageText[]): number | null {
  const needle = norm(label);
  const hits = pages.filter((p) => norm(p.text).includes(needle));
  // A label such as "…-1" is also contained in "…-10": prefer a page where it is followed by a non-digit.
  const exact = hits.filter((p) => new RegExp(`${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`).test(norm(p.text)));
  if (exact.length === 1) return exact[0]!.page;
  if (exact.length > 1) return null;
  return null;
}

export function verifyManualTables(doc: ManualDocument, pages: PageText[]): TableCheck[] {
  return doc.tables.map((t) => {
    const documentPage = locatePage(t.page, pages);
    if (documentPage === null) {
      return { tableId: t.id, pageLabel: t.page, documentPage: null, rows: t.rows.length, factorsFound: 0, missing: [], ok: false, detail: `The page “${t.page}” was not found as a single page of the document, so this table's factors could not be checked.` };
    }
    const found = numbersOn(pages.find((p) => p.page === documentPage)!.text);
    const wanted = [
      ...t.rows.map((r) => ({ label: `${r.keys.join(' · ')} → ${r.factor}`, factor: r.factor })),
      ...(t.unused ? [{ label: `unused → ${t.unused}`, factor: t.unused }] : []),
      ...(t.unknown ? [{ label: `unknown → ${t.unknown}`, factor: t.unknown }] : []),
    ];
    const missing = wanted.filter((w) => {
      const c = canonical(w.factor);
      return c === null || !found.has(c);
    });
    const ok = missing.length === 0;
    return {
      tableId: t.id,
      pageLabel: t.page,
      documentPage,
      rows: t.rows.length,
      factorsFound: wanted.length - missing.length,
      missing: missing.map((m) => m.label),
      ok,
      detail: ok ? `All ${wanted.length} factors are on page ${documentPage}.` : `${missing.length} of ${wanted.length} factors are not on page ${documentPage}.`,
    };
  });
}
