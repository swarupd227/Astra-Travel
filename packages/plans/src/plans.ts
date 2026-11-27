import type {
  CatalogueDocument,
  PlanDiff,
  PlanDocument,
  PlanProblem,
  PlanValue,
  QuoteRatingRequest,
  VariableType,
} from '@astra/contracts';
import { BENEFIT_GROUPS, PLAN_SETTING_LABELS } from '@astra/contracts';
import { checkValue } from '@astra/studio';
import { refKey, requiredValues } from './required';

export { requiredValues } from './required';

/** Plan checks, rating requests from plans, and version comparison (E01-F03, E01-F04). */

export interface FormVariableInfo {
  label: string;
  type: VariableType;
  constraints: Record<string, unknown>;
}
/** Variables of the approved maps, keyed `schedule:key` / `policy:key`. */
export type PlanVariables = Map<string, FormVariableInfo>;

export function validatePlan(
  doc: PlanDocument,
  cat: CatalogueDocument,
  vars: PlanVariables,
  parent: { document: PlanDocument; kind: 'base' | 'state' | 'account' } | null = null,
  kind: 'base' | 'state' | 'account' = 'base',
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });

  const seen = (list: { code: string }[], area: string) => {
    const s = new Set<string>();
    for (const x of list) {
      if (s.has(x.code)) add(`${area}.${x.code}`, `${x.code} is listed twice.`);
      s.add(x.code);
    }
  };
  seen(doc.benefits, 'benefits');
  seen(doc.upgrades, 'upgrades');
  seen(doc.coveredReasons, 'coveredReasons');

  for (const b of doc.benefits)
    if (!cat.benefits.some((x) => x.code === b.code))
      add(`benefits.${b.code}`, `The catalogue has no benefit ${b.code}.`);
  for (const u of doc.upgrades)
    if (!cat.upgrades.some((x) => x.code === u.code))
      add(`upgrades.${u.code}`, `The catalogue has no upgrade ${u.code}.`);
  for (const r of doc.coveredReasons) {
    const c = cat.coveredReasons.find((x) => x.code === r.code);
    if (!c) {
      add(`coveredReasons.${r.code}`, `The catalogue has no covered reason ${r.code}.`);
      continue;
    }
    const extra = r.levels.filter((l) => !c.coverageLevels.includes(l));
    if (extra.length)
      add(
        `coveredReasons.${r.code}`,
        `${c.text}: the form does not cover ${extra.join(', ').replace(/_/g, ' ')}.`,
      );
    if (c.upgrade && !doc.upgrades.some((u) => u.code === c.upgrade)) {
      add(
        `coveredReasons.${r.code}`,
        `${c.text} comes with the ${c.upgrade} upgrade, which the plan does not offer.`,
      );
    }
  }

  const check = (path: string, key: string, value: PlanValue) => {
    const v = vars.get(key);
    if (!v) {
      add(path, `${key} is not in the approved variable maps.`);
      return;
    }
    const r = checkValue({ label: v.label, type: v.type, constraints: v.constraints }, value);
    if (!r.ok) add(path, r.message);
  };
  for (const [key, value] of Object.entries(doc.values)) check(`values.${key}`, key, value);
  for (const key of requiredValues(doc, cat)) {
    if (!(key in doc.values) || doc.values[key] === null)
      add(`values.${key}`, `${vars.get(key)?.label ?? key} needs a value.`);
  }

  const settings = new Set<string>();
  for (const s of doc.settings) {
    if (settings.has(s.setting)) add(`settings.${s.setting}`, `${s.setting} is set twice.`);
    settings.add(s.setting);
    if (!vars.has(refKey(s.variable))) {
      add(
        `settings.${s.setting}`,
        `Choose the form variable ${PLAN_SETTING_LABELS[s.setting]} is filed as.`,
      );
      continue;
    }
    check(`settings.${s.setting}`, refKey(s.variable), s.value);
  }

  // Timing is keyed by a benefit group or a benefit of the catalogue (E05-F03-S01).
  for (const key of Object.keys(doc.timing)) {
    if (
      !(BENEFIT_GROUPS as readonly string[]).includes(key) &&
      !cat.benefits.some((b) => b.code === key)
    ) {
      add(`timing.${key}`, `${key} is neither a benefit group nor a benefit of the catalogue.`);
    }
  }

  if (kind !== 'base' && Object.keys(doc.bounds).length)
    add('bounds', 'Only base plans set bounds for account plans.');
  if (kind === 'base') {
    for (const [key, b] of Object.entries(doc.bounds)) {
      const v = vars.get(key);
      if (!v) add(`bounds.${key}`, `${key} is not in the approved variable maps.`);
      else if (b.min !== undefined && b.max !== undefined && b.min > b.max)
        add(`bounds.${key}`, 'The lower bound is above the upper bound.');
    }
  }

  // Account plans change only what the base plan leaves open, within its bounds (E01-F03-S04).
  if (kind === 'account' && parent) {
    const bounds = parent.document.bounds;
    const parentValues = parent.document.values;
    for (const [key, value] of Object.entries(doc.values)) {
      const bound = bounds[key];
      const same = JSON.stringify(value) === JSON.stringify(parentValues[key]);
      if (!bound) {
        if (!same)
          add(`values.${key}`, `${vars.get(key)?.label ?? key} is fixed by the base plan.`);
        continue;
      }
      const n =
        typeof value === 'number'
          ? value
          : typeof value === 'object' && value && 'percent' in value
            ? value.percent
            : null;
      if (
        n !== null &&
        ((bound.min !== undefined && n < bound.min) || (bound.max !== undefined && n > bound.max))
      ) {
        add(
          `values.${key}`,
          `${vars.get(key)?.label ?? key} must be between ${bound.min ?? '—'} and ${bound.max ?? '—'} for account plans.`,
        );
      }
      if (bound.options) {
        const chosen = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
        const bad = chosen.filter((x) => !bound.options!.includes(x));
        if (bad.length)
          add(
            `values.${key}`,
            `${vars.get(key)?.label ?? key}: account plans may choose only ${bound.options.join(', ')}.`,
          );
      }
    }
    const structure = (d: PlanDocument) =>
      JSON.stringify({ b: d.benefits, u: d.upgrades, r: d.coveredReasons, s: d.settings });
    if (structure(doc) !== structure(parent.document)) {
      add(
        'benefits',
        'Account plans keep the benefits, upgrades, covered reasons and settings of the plan they come from; only open values change.',
      );
    }
  }
  return problems;
}

const settingValue = (doc: PlanDocument, name: string) =>
  doc.settings.find((s) => s.setting === name)?.value ?? null;

/**
 * The rating request for a quote on this plan: the plan supplies package types, the peril package
 * (covered reasons and levels, with the catalogue's peril numbers), the lookback period, CFAR and Trip
 * Interruption settings; the quote supplies travellers, trip and account.
 */
export function planToQuote(
  doc: PlanDocument,
  cat: CatalogueDocument,
  state: string,
  input: Pick<QuoteRatingRequest, 'rateDate' | 'travellers' | 'trip' | 'account'> & {
    cfarEligibility?: QuoteRatingRequest['benefits'][number]['cfarEligibility'];
  },
): QuoteRatingRequest {
  const lookback = settingValue(doc, 'lookback_period');
  const cfarPercent = settingValue(doc, 'cfar_percent');
  const cfarBasis = settingValue(doc, 'cfar_basis');
  const interruption = settingValue(doc, 'interruption_limit_percent');
  const perilsFor = (applies: 'trip_cancellation' | 'trip_interruption') =>
    doc.coveredReasons
      .map((r) => ({ plan: r, reason: cat.coveredReasons.find((c) => c.code === r.code) }))
      .filter((x) => x.reason && x.reason.perilNumber && x.reason.appliesTo.includes(applies))
      .map((x) => ({ peril: x.reason!.perilNumber!, levels: x.plan.levels }));
  const cfarPct =
    typeof cfarPercent === 'number'
      ? cfarPercent
      : typeof cfarPercent === 'object' && cfarPercent && 'percent' in cfarPercent
        ? cfarPercent.percent
        : null;
  const basisText = Array.isArray(cfarBasis)
    ? cfarBasis[0]
    : typeof cfarBasis === 'string'
      ? cfarBasis
      : null;
  return {
    state,
    rateDate: input.rateDate,
    travellers: input.travellers,
    trip: input.trip,
    account: input.account,
    benefits: doc.benefits
      .filter((b) => b.ratingBenefit)
      .map((b) => ({
        benefit: b.ratingBenefit!,
        plan: {
          packageType: b.packaging === 'packaged' ? ('packaged' as const) : ('optional' as const),
          lookbackDays: typeof lookback === 'number' ? lookback : null,
          productType: doc.productType,
          perils:
            b.ratingBenefit === 'TCAN'
              ? perilsFor('trip_cancellation')
              : b.ratingBenefit === 'TINT'
                ? perilsFor('trip_interruption')
                : [],
          waivedExclusions: [],
          supplemental: [],
          ...(b.ratingBenefit === 'CFAR' && cfarPct !== null
            ? {
                cfar: {
                  percent: cfarPct,
                  basis: /air/i.test(basisText ?? '') ? ('air' as const) : ('trip' as const),
                },
              }
            : {}),
          ...(b.ratingBenefit === 'TINT' && typeof interruption === 'number'
            ? { interruption: { limitPercent: interruption } }
            : {}),
        },
        ...(b.ratingBenefit === 'CFAR' && input.cfarEligibility
          ? { cfarEligibility: input.cfarEligibility }
          : {}),
      })),
  };
}

const show = (v: unknown) =>
  v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);

/** What changed between two plan versions (E01-F04-S02). */
export function diffPlans(
  from: {
    id: string;
    version: number;
    document: PlanDocument;
    links: Record<string, string>;
    effectiveFrom: string;
  },
  to: {
    id: string;
    version: number;
    document: PlanDocument;
    links: Record<string, string>;
    effectiveFrom: string;
  },
): PlanDiff {
  const changes: PlanDiff['changes'] = [];
  const cmp = <T>(
    area: PlanDiff['changes'][number]['area'],
    a: Record<string, T>,
    b: Record<string, T>,
  ) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = show(a[k]);
      const y = show(b[k]);
      if (x === y) continue;
      changes.push({
        area,
        item: k,
        change: x === null ? 'added' : y === null ? 'removed' : 'changed',
        before: x,
        after: y,
      });
    }
  };
  const byCode = <T extends { code: string }>(xs: T[], f: (x: T) => unknown) =>
    Object.fromEntries(xs.map((x) => [x.code, f(x)]));
  cmp(
    'benefit',
    byCode(from.document.benefits, (b) => ({
      packaging: b.packaging,
      rated: b.ratingBenefit,
      underwriter: b.underwriter,
    })),
    byCode(to.document.benefits, (b) => ({
      packaging: b.packaging,
      rated: b.ratingBenefit,
      underwriter: b.underwriter,
    })),
  );
  cmp('timing', from.document.timing, to.document.timing);
  cmp(
    'upgrade',
    byCode(from.document.upgrades, (u) => u.packaging),
    byCode(to.document.upgrades, (u) => u.packaging),
  );
  cmp(
    'covered_reason',
    byCode(from.document.coveredReasons, (r) => r.levels.join(', ')),
    byCode(to.document.coveredReasons, (r) => r.levels.join(', ')),
  );
  cmp('value', from.document.values, to.document.values);
  const settings = (d: PlanDocument) =>
    Object.fromEntries(
      d.settings.map((s) => [s.setting, { variable: refKey(s.variable), value: s.value }]),
    );
  cmp('setting', settings(from.document), settings(to.document));
  cmp('bound', from.document.bounds, to.document.bounds);
  cmp('link', from.links, to.links);
  if (from.effectiveFrom !== to.effectiveFrom)
    changes.push({
      area: 'dates',
      item: 'effective from',
      change: 'changed',
      before: from.effectiveFrom,
      after: to.effectiveFrom,
    });
  return {
    from: { id: from.id, version: from.version },
    to: { id: to.id, version: to.version },
    changes,
  };
}
