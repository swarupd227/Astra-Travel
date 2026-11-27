import type { Condition, RuleField, RuleSetDocument } from '@astra/contracts';
import { LIMIT_LABELS, RULE_FIELD_LABELS, RULE_OP_LABELS } from '@astra/contracts';

/** Referral conditions are data: a tree of comparisons over a fixed list of fields (ADR 0008). */

export type FieldValue = number | string | null;
/** Single values, or lists for fields with several values (destinations). */
export type FieldContext = Partial<Record<RuleField, FieldValue | FieldValue[]>>;

const NUMERIC: ReadonlySet<RuleField> = new Set([
  'traveller_age',
  'cost_per_traveller',
  'trip_days',
  'total_trip_cost',
  'traveller_count',
  'days_before_departure',
  'insured_percent',
]);

export const isNumericField = (f: RuleField) => NUMERIC.has(f);

const same = (a: FieldValue, b: number | string) =>
  typeof a === 'number'
    ? a === Number(b)
    : String(a ?? '').toLowerCase() === String(b).toLowerCase();

/** Evaluates a condition; a field with no value never satisfies a comparison (the rule does not fire). */
export function evaluateCondition(c: Condition, ctx: FieldContext): boolean {
  if ('all' in c) return c.all.every((x) => evaluateCondition(x, ctx));
  if ('any' in c) return c.any.some((x) => evaluateCondition(x, ctx));
  if ('not' in c) return !evaluateCondition(c.not, ctx);
  const raw = ctx[c.field];
  const values = (Array.isArray(raw) ? raw : [raw ?? null]).filter(
    (v): v is number | string => v !== null && v !== undefined,
  );
  if (values.length === 0) return false;
  const wanted = Array.isArray(c.value) ? c.value : [c.value];
  switch (c.op) {
    case 'eq':
    case 'in':
      return values.some((v) => wanted.some((w) => same(v, w)));
    case 'neq':
    case 'not_in':
      return !values.some((v) => wanted.some((w) => same(v, w)));
    default: {
      const n = Number(wanted[0]);
      return values.some((v) => {
        const x = Number(v);
        return c.op === 'gt' ? x > n : c.op === 'gte' ? x >= n : c.op === 'lt' ? x < n : x <= n;
      });
    }
  }
}

/** Plain-words description of a condition, shown in the rule editor and in referral summaries. */
export function describeCondition(c: Condition): string {
  if ('all' in c) return c.all.map((x) => describeCondition(x)).join(' and ');
  if ('any' in c) return `(${c.any.map((x) => describeCondition(x)).join(' or ')})`;
  if ('not' in c) return `not (${describeCondition(c.not)})`;
  const v = Array.isArray(c.value) ? c.value.join(', ') : String(c.value);
  return `${RULE_FIELD_LABELS[c.field].toLowerCase()} ${RULE_OP_LABELS[c.op]} ${v}`;
}

/** Problems with a rule set that can be found without data: duplicate codes, comparisons that make no sense. */
export function checkRuleSet(doc: RuleSetDocument): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const dup = (codes: string[], area: string) => {
    const seen = new Set<string>();
    for (const c of codes) {
      if (seen.has(c)) problems.push({ path: `${area}.${c}`, message: `${c} is listed twice.` });
      seen.add(c);
    }
  };
  dup(
    doc.limits.map((l) => l.code),
    'limits',
  );
  dup(
    doc.referralRules.map((r) => r.code),
    'referralRules',
  );
  for (const kind of ['age', 'trip_days', 'trip_cost'] as const) {
    const lo = doc.limits.find((l) => l.kind === `min_${kind}`);
    const hi = doc.limits.find((l) => l.kind === `max_${kind}`);
    if (lo && hi && lo.value > hi.value)
      problems.push({
        path: `limits.${hi.code}`,
        message: `${LIMIT_LABELS[lo.kind]} is above ${LIMIT_LABELS[hi.kind].toLowerCase()}.`,
      });
  }
  const walk = (c: Condition, path: string) => {
    if ('all' in c) c.all.forEach((x) => walk(x, path));
    else if ('any' in c) c.any.forEach((x) => walk(x, path));
    else if ('not' in c) walk(c.not, path);
    else {
      const numeric = isNumericField(c.field);
      const values = Array.isArray(c.value) ? c.value : [c.value];
      if (numeric && values.some((v) => typeof v !== 'number' && Number.isNaN(Number(v)))) {
        problems.push({
          path,
          message: `${RULE_FIELD_LABELS[c.field]} is compared with a number.`,
        });
      }
      if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && !numeric) {
        problems.push({
          path,
          message: `${RULE_FIELD_LABELS[c.field]} cannot be compared with “${RULE_OP_LABELS[c.op]}”.`,
        });
      }
      if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && Array.isArray(c.value)) {
        problems.push({ path, message: `“${RULE_OP_LABELS[c.op]}” takes one value.` });
      }
    }
  };
  for (const r of doc.referralRules) walk(r.when, `referralRules.${r.code}`);
  return problems;
}
