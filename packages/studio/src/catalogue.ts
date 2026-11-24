import type {
  Amount,
  Benefit,
  CatalogueDocument,
  CatalogueProblem,
  VariableRef,
  VariableType,
} from '@astra/contracts';

/**
 * Benefit catalogue checks (E01-F02). Every reference must name a variable in the approved variable map of
 * the schedule or policy form, of a type that fits its use; codes are unique; replacement targets exist;
 * and, for approval, every covered reason has its rating-manual peril number.
 */

export type VariableTypes = {
  schedule: Map<string, VariableType>;
  policy: Map<string, VariableType> | null;
  /** Filed maximums of numeric variables (`schedule:key`), for checks between amounts. */
  maximums?: Map<string, number>;
};

const label = (r: VariableRef) => `${r.source}:${r.key}`;

export function validateCatalogue(doc: CatalogueDocument, maps: VariableTypes): CatalogueProblem[] {
  const problems: CatalogueProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });

  const ref = (
    path: string,
    r: VariableRef | null | undefined,
    allowed: VariableType[],
    what: string,
  ) => {
    if (!r) return;
    const map = r.source === 'schedule' ? maps.schedule : maps.policy;
    if (!map) {
      add(
        path,
        `${label(r)}: this catalogue has no policy form; add one or use a schedule variable.`,
      );
      return;
    }
    const type = map.get(r.key);
    if (!type) add(path, `${label(r)} is not in the approved variable map.`);
    else if (!allowed.includes(type))
      add(
        path,
        `${label(r)} is a ${type.replace(/_/g, ' ')}; ${what} needs a ${allowed.map((a) => a.replace(/_/g, ' ')).join(' or ')}.`,
      );
  };
  const amount = (path: string, a: Amount | null | undefined) => {
    if (!a) return;
    ref(`${path}.variable`, a.variable, ['numeric_range'], 'an amount');
    if (a.basis.kind === 'variable')
      ref(`${path}.basis`, a.basis.variable, ['limit_basis'], 'a limit basis');
  };
  const unique = (kind: string, codes: string[]) => {
    const seen = new Set<string>();
    for (const c of codes) {
      if (seen.has(c)) add(`${kind}.${c}`, `The code ${c} is used more than once.`);
      seen.add(c);
    }
  };

  unique(
    'benefits',
    doc.benefits.map((b) => b.code),
  );
  unique(
    'coveredReasons',
    doc.coveredReasons.map((r) => r.code),
  );
  unique(
    'upgrades',
    doc.upgrades.map((u) => u.code),
  );
  const benefits = new Map(doc.benefits.map((b) => [b.code, b]));
  const upgrades = new Set(doc.upgrades.map((u) => u.code));

  for (const b of doc.benefits) {
    const p = `benefits.${b.code}`;
    ref(`${p}.optional`, b.optional, ['optional_benefit'], 'switching a benefit on');
    amount(`${p}.maximum`, b.maximum);
    amount(`${p}.perDay`, b.perDay);
    amount(`${p}.deductible`, b.deductible);
    unique(
      `${p}.subLimits`,
      b.subLimits.map((s) => s.code),
    );
    for (const s of b.subLimits) {
      amount(`${p}.subLimits.${s.code}.amount`, s.amount);
      // A sub-limit that is part of the maximum cannot be filed higher than the maximum itself.
      const subMax = maps.maximums?.get(label(s.amount.variable));
      const parentMax = maps.maximums?.get(label(b.maximum.variable));
      if (
        s.includedInParent &&
        subMax !== undefined &&
        parentMax !== undefined &&
        subMax > parentMax
      ) {
        add(
          `${p}.subLimits.${s.code}.amount`,
          `${s.name} is included in the maximum benefit but can be up to ${subMax.toLocaleString('en-US')}, more than the maximum's ${parentMax.toLocaleString('en-US')}.`,
        );
      }
      ref(
        `${p}.subLimits.${s.code}.optional`,
        s.optional,
        ['optional_benefit'],
        'switching a sub-limit on',
      );
    }
    unique(
      `${p}.eventAmounts`,
      b.eventAmounts.map((e) => e.code),
    );
    for (const e of b.eventAmounts)
      ref(`${p}.eventAmounts.${e.code}`, e.amount, ['numeric_range'], 'an event amount');
  }

  for (const r of doc.coveredReasons) {
    const p = `coveredReasons.${r.code}`;
    if (r.upgrade && !upgrades.has(r.upgrade))
      add(`${p}.upgrade`, `No upgrade ${r.upgrade} in this catalogue.`);
    if (!r.perilNumber)
      add(`${p}.perilNumber`, 'The peril number from the rating manual is missing.');
    if (new Set(r.coverageLevels).size !== r.coverageLevels.length)
      add(`${p}.coverageLevels`, 'A coverage level is listed twice.');
  }

  for (const u of doc.upgrades) {
    const p = `upgrades.${u.code}`;
    ref(`${p}.offeredBy`, u.offeredBy, ['optional_benefit'], 'offering an upgrade');
    for (const code of u.benefits)
      if (!benefits.has(code)) add(`${p}.benefits`, `No benefit ${code} in this catalogue.`);
    if (u.kind === 'limit_replacement' && u.replacements.length === 0)
      add(`${p}.replacements`, 'An upgrade that replaces limits must name what it replaces.');
    if (u.kind === 'covered_reason_set' && !doc.coveredReasons.some((r) => r.upgrade === u.code)) {
      add(`${p}`, 'No covered reasons belong to this reason set yet.');
    }
    const targets = new Set<string>();
    u.replacements.forEach((rep, i) => {
      const t = rep.target;
      const b = benefits.get(t.benefit);
      const tp = `${p}.replacements.${i}`;
      if (!b) {
        add(tp, `No benefit ${t.benefit} in this catalogue.`);
      } else if (t.kind === 'benefit' && t.field !== 'maximum' && !b[t.field]) {
        add(
          tp,
          `${b.name} has no ${t.field === 'perDay' ? 'per-day limit' : 'deductible'} to replace.`,
        );
      } else if (t.kind === 'sub_limit' && !b.subLimits.some((s) => s.code === t.subLimit)) {
        add(tp, `${b.name} has no sub-limit ${t.subLimit}.`);
      }
      const key = t.kind === 'benefit' ? `${t.benefit}.${t.field}` : `${t.benefit}.${t.subLimit}`;
      if (targets.has(key)) add(tp, `This upgrade replaces ${key} twice.`);
      targets.add(key);
      amount(`${tp}.amount`, rep.amount);
    });
  }
  return problems;
}

/** Problems for one item (and anything inside it); used to refuse saving an item with a bad reference. */
export function problemsFor(
  problems: CatalogueProblem[],
  path: string,
  ignorePerils = true,
): CatalogueProblem[] {
  return problems.filter(
    (p) =>
      (p.path === path || p.path.startsWith(`${path}.`)) &&
      !(ignorePerils && p.path.endsWith('.perilNumber')),
  );
}

export interface EffectiveBenefit {
  code: string;
  maximum: Amount;
  perDay: Amount | null;
  deductible: Amount | null;
  subLimits: Record<string, Amount>;
  /** Which upgrade replaced which amount. */
  replacedBy: Record<string, string>;
}

export class UpgradeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeConflictError';
  }
}

/**
 * The limits in force once the selected upgrades are applied: an upgrade that replaces limits swaps in its
 * replacement amounts (E01-F02-S03). Two selected upgrades may not replace the same amount.
 */
export function effectiveLimits(
  doc: CatalogueDocument,
  selectedUpgrades: readonly string[],
): Map<string, EffectiveBenefit> {
  const out = new Map<string, EffectiveBenefit>();
  for (const b of doc.benefits) {
    out.set(b.code, {
      code: b.code,
      maximum: b.maximum,
      perDay: b.perDay,
      deductible: b.deductible,
      subLimits: Object.fromEntries(b.subLimits.map((s) => [s.code, s.amount])),
      replacedBy: {},
    });
  }
  for (const code of selectedUpgrades) {
    const u = doc.upgrades.find((x) => x.code === code);
    if (!u) throw new UpgradeConflictError(`No upgrade ${code} in this catalogue.`);
    for (const rep of u.replacements) {
      const e = out.get(rep.target.benefit) as EffectiveBenefit | undefined;
      if (!e) continue;
      const slot =
        rep.target.kind === 'benefit' ? rep.target.field : `subLimits.${rep.target.subLimit}`;
      const earlier = e.replacedBy[slot];
      if (earlier)
        throw new UpgradeConflictError(
          `${u.name} and ${earlier} both replace ${b(doc, e.code)} ${slot}.`,
        );
      e.replacedBy[slot] = u.name;
      if (rep.target.kind === 'benefit')
        (e as unknown as Record<string, Amount>)[rep.target.field] = rep.amount;
      else e.subLimits[rep.target.subLimit] = rep.amount;
    }
  }
  return out;
}

function b(doc: CatalogueDocument, code: string): string {
  return doc.benefits.find((x: Benefit) => x.code === code)?.name ?? code;
}
