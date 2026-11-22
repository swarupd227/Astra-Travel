import type { VariableType } from '@astra/contracts';

/**
 * Checks a configured value against a variable's filed range or options (M1 business rule: "A plan value
 * outside the filed range cannot be saved"). Used by the plan builder (Increment 6).
 */

export type ValueCheck = { ok: true } | { ok: false; message: string };

const fail = (message: string): ValueCheck => ({ ok: false, message });
const ok: ValueCheck = { ok: true };

interface Variable {
  label: string;
  type: VariableType;
  constraints: Record<string, unknown>;
}

function inRange(label: string, n: unknown, c: Record<string, unknown>, unit = ''): ValueCheck {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fail(`${label} needs a number.`);
  const min = c.min as number;
  const max = c.max as number;
  if (n < min || n > max)
    return fail(`${label} must be between ${min}${unit} and ${max}${unit} (filed range).`);
  return ok;
}

export function checkValue(v: Variable, value: unknown): ValueCheck {
  const c = v.constraints;
  switch (v.type) {
    case 'optional_benefit':
      return typeof value === 'boolean' ? ok : fail(`${v.label} is either included or not.`);
    case 'numeric_range':
      return inRange(v.label, value, c, c.unit === 'usd' ? '' : '');
    case 'time_period':
      return inRange(v.label, value, c, ` ${c.unit as string}`);
    case 'percentage_range': {
      const val = value as { percent?: unknown; basis?: unknown } | null;
      if (!val || typeof val !== 'object') return fail(`${v.label} needs a percentage.`);
      const r = inRange(v.label, val.percent, c, '%');
      if (!r.ok) return r;
      const bases = (c.bases as string[]) ?? [];
      if (bases.length && !bases.includes(val.basis as string))
        return fail(`${v.label} basis must be one of: ${bases.join(', ')}.`);
      if (!bases.length && val.basis !== undefined)
        return fail(`${v.label} has no filed basis to choose.`);
      return ok;
    }
    case 'wording_choice': {
      const options = c.options as string[];
      if (!Array.isArray(value) || value.length === 0)
        return fail(`Choose the wording for ${v.label}.`);
      if (!c.multiple && value.length > 1)
        return fail(`${v.label} takes one of the filed alternatives.`);
      const bad = value.filter((x) => !options.includes(x as string));
      if (bad.length)
        return fail(`${v.label}: only the filed wording is allowed; free text is not.`);
      if (new Set(value).size !== value.length) return fail(`${v.label}: each alternative once.`);
      return ok;
    }
    case 'limit_basis':
      return (c.options as string[]).includes(value as string)
        ? ok
        : fail(`${v.label} must be one of: ${(c.options as string[]).join(', ')}.`);
    case 'insert_placeholder':
      if (c.source === 'dataset') {
        return value === null || value === undefined
          ? ok
          : fail(`${v.label} is filled from reference data.`);
      }
      if (typeof value !== 'string' || !value.trim()) return fail(`${v.label} needs a value.`);
      if (c.source === 'url') {
        try {
          const u = new URL(value);
          return u.protocol === 'https:' ? ok : fail(`${v.label} must be an https address.`);
        } catch {
          return fail(`${v.label} must be a web address.`);
        }
      }
      return value.length <= 2000 ? ok : fail(`${v.label} is too long.`);
  }
}
