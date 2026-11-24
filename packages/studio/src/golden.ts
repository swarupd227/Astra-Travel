/**
 * Comparison of a proposed variable map with a manually prepared list (E01-F01-S03, criterion 4): the
 * agent must find every variable of the sample schedule with the same type and filed range. Wording is
 * identified by its exact excerpt, so the comparison does not depend on offsets or on the keys chosen.
 */

export interface GoldenVariable {
  excerpt: string;
  type: string;
  constraints: Record<string, unknown>;
}

export interface GoldenComparison {
  /** Golden variables found with the same type and constraints. */
  matched: string[];
  /** Golden variables not proposed at all. */
  missing: string[];
  /** Proposed with a different type or range. */
  mismatched: { excerpt: string; expected: GoldenVariable; actual: GoldenVariable }[];
  /** Proposed but not in the golden list: for a person to look at, not necessarily wrong. */
  extra: string[];
  /** matched / golden size; 1 means every golden variable was found exactly. */
  recall: number;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

export function compareToGolden(proposed: GoldenVariable[], golden: GoldenVariable[]): GoldenComparison {
  const byExcerpt = new Map(proposed.map((p) => [p.excerpt, p]));
  const out: GoldenComparison = { matched: [], missing: [], mismatched: [], extra: [], recall: 1 };
  for (const g of golden) {
    const p = byExcerpt.get(g.excerpt);
    if (!p) out.missing.push(g.excerpt);
    else if (p.type !== g.type || stable(p.constraints) !== stable(g.constraints)) out.mismatched.push({ excerpt: g.excerpt, expected: g, actual: p });
    else out.matched.push(g.excerpt);
  }
  const wanted = new Set(golden.map((g) => g.excerpt));
  out.extra = proposed.filter((p) => !wanted.has(p.excerpt)).map((p) => p.excerpt);
  out.recall = golden.length ? out.matched.length / golden.length : 1;
  return out;
}
