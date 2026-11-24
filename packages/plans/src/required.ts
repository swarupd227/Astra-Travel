import type { Amount, CatalogueDocument, PlanDocument } from '@astra/contracts';

/** Browser-safe plan helpers (no database or PDF dependencies). */

export const refKey = (r: { source: string; key: string }) => `${r.source}:${r.key}`;

/** Every variable an included benefit or upgrade needs a value for. */
export function requiredValues(doc: PlanDocument, cat: CatalogueDocument): string[] {
  const keys = new Set<string>();
  const amount = (a: Amount | null | undefined) => {
    if (!a) return;
    keys.add(refKey(a.variable));
    if (a.basis.kind === 'variable') keys.add(refKey(a.basis.variable));
  };
  for (const pb of doc.benefits) {
    const b = cat.benefits.find((x) => x.code === pb.code);
    if (!b) continue;
    amount(b.maximum);
    amount(b.perDay);
    amount(b.deductible);
    for (const s of b.subLimits) {
      // An optional sub-limit switched off needs no amount.
      if (s.optional && doc.values[refKey(s.optional)] === false) continue;
      amount(s.amount);
    }
    for (const e of b.eventAmounts) keys.add(refKey(e.amount));
  }
  for (const pu of doc.upgrades) {
    const u = cat.upgrades.find((x) => x.code === pu.code);
    u?.replacements.forEach((r) => amount(r.amount));
  }
  return [...keys].sort();
}
