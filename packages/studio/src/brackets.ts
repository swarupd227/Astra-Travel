import type { VariableType } from '@astra/contracts';
import { pageOf } from './text';

/**
 * Finds the variable wording in a filed form: every `[...]` span (with nesting) and every `<<insert ...>>`
 * placeholder, and proposes a variable type and range where the wording makes it unambiguous. Adjacent
 * alternatives such as `[cruise][tour][trip]` or `[PER PERSON] [PER TRIP]` are grouped into one candidate.
 * Proposals are suggestions only: a person accepts or corrects each one before it is saved.
 */

export interface Suggestion {
  type: VariableType;
  constraints: Record<string, unknown>;
  why: string;
}

export interface BracketCandidate {
  start: number;
  end: number;
  text: string;
  depth: number;
  page: number;
  suggestion: Suggestion | null;
}

interface Span {
  start: number;
  end: number;
  depth: number;
  kind: 'bracket' | 'placeholder';
}

const DASH = /[-‐-―]/;

function spans(text: string): Span[] {
  const out: Span[] = [];
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<' && text[i + 1] === '<') {
      const close = text.indexOf('>>', i + 2);
      if (close > i && close - i < 400) {
        out.push({ start: i, end: close + 2, depth: stack.length, kind: 'placeholder' });
        i = close + 1;
      }
      continue;
    }
    if (ch === '[') stack.push(i);
    else if (ch === ']' && stack.length) {
      const start = stack.pop()!;
      out.push({ start, end: i + 1, depth: stack.length, kind: 'bracket' });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Numbers written as digits, preferring the ones in parentheses: "ten (10)" gives 10. */
function numbers(inner: string): number[] {
  const parens = [...inner.matchAll(/\((\$?\s?[\d,]+(?:\.\d+)?)\s*%?\)/g)].map((m) =>
    toNumber(m[1]!),
  );
  if (parens.length >= 2) return parens;
  return [...inner.matchAll(/\$?\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => toNumber(m[1]!));
}

function toNumber(s: string): number {
  return Number(s.replace(/[$,\s]/g, ''));
}

function hasRangeDash(inner: string): boolean {
  return DASH.test(inner) || /\bto\b/i.test(inner);
}

/** fter is the wording just after the bracket, where a unit often sits: [ten (10) - fifteen (15)] day. */
export function suggest(inner: string, after = ''): Suggestion | null {
  const body = inner.trim();
  if (/^\[\s*optional\s*\]/i.test(body)) {
    return { type: 'optional_benefit', constraints: {}, why: 'Marked [Optional] in the form.' };
  }
  const nums = numbers(body);
  if (nums.length === 2 && hasRangeDash(body) && nums[1]! >= nums[0]!) {
    const [min, max] = nums as [number, number];
    if (/\$/.test(body)) {
      return {
        type: 'numeric_range',
        constraints: { min, max, unit: 'usd' },
        why: `Dollar range ${min} to ${max}.`,
      };
    }
    if (/%|percent/i.test(body)) {
      return {
        type: 'percentage_range',
        constraints: { min, max, bases: [] },
        why: `Percentage range ${min}% to ${max}%. Add the basis (for example air cost or trip cost) if the form gives one.`,
      };
    }
    const unitText = `${body} ${/^\s*-?\s*(\w+)/.exec(after)?.[1] ?? ''}`;
    const unit = /hour/i.test(unitText)
      ? 'hours'
      : /\bdays?\b/i.test(unitText)
        ? 'days'
        : /month/i.test(unitText)
          ? 'months'
          : /year/i.test(unitText)
            ? 'years'
            : null;
    if (unit) {
      return {
        type: 'time_period',
        constraints: { min, max, unit },
        why: `Period of ${min} to ${max} ${unit}.`,
      };
    }
    return {
      type: 'numeric_range',
      constraints: { min, max, unit: 'number' },
      why: `Range ${min} to ${max}.`,
    };
  }
  return null;
}

function placeholderSuggestion(inner: string): Suggestion {
  if (/countr|destination/i.test(inner)) {
    return {
      type: 'insert_placeholder',
      constraints: { source: 'dataset', dataset: 'prohibited_destinations' },
      why: 'A list of countries: filled from the prohibited destinations reference data.',
    };
  }
  if (/website|url|web address/i.test(inner)) {
    return { type: 'insert_placeholder', constraints: { source: 'url' }, why: 'A web address.' };
  }
  return {
    type: 'insert_placeholder',
    constraints: { source: 'text' },
    why: 'A controlled text value.',
  };
}

export function findBrackets(text: string, pageStarts: number[] = [0]): BracketCandidate[] {
  const all = spans(text);
  const out: BracketCandidate[] = [];
  const used = new Set<Span>();

  // Group runs of sibling brackets separated only by spaces into one choice. Only plain alternatives
  // group: a bracket that reads as a range or an optional benefit stands on its own, so
  // "[$10,000-$500,000] [PER PERSON] [PER TRIP]" is an amount followed by a limit basis.
  const plainAlternative = (sp: Span) =>
    sp.kind === 'bracket' && suggest(text.slice(sp.start + 1, sp.end - 1)) === null;
  for (let i = 0; i < all.length; i++) {
    const s = all[i]!;
    if (used.has(s) || !plainAlternative(s)) continue;
    const run = [s];
    let j = i + 1;
    while (j < all.length) {
      const next = all[j]!;
      if (next.start < run.at(-1)!.end) {
        j++;
        continue; // nested inside the run
      }
      if (
        plainAlternative(next) &&
        next.depth === s.depth &&
        /^[ \t]{0,2}$/.test(text.slice(run.at(-1)!.end, next.start))
      ) {
        run.push(next);
        j++;
        continue;
      }
      break;
    }
    if (run.length < 2) continue;
    const opts = run.map((r) => text.slice(r.start + 1, r.end - 1).trim());
    if (opts.some((o) => o.includes('[') || o.length === 0)) continue;
    run.forEach((r) => used.add(r));
    const basis = opts.every((o) => /^per\s/i.test(o));
    out.push({
      start: run[0]!.start,
      end: run.at(-1)!.end,
      text: text.slice(run[0]!.start, run.at(-1)!.end),
      depth: s.depth,
      page: pageOf(pageStarts, run[0]!.start),
      suggestion: basis
        ? {
            type: 'limit_basis',
            constraints: { options: opts },
            why: `${opts.length} filed limit bases.`,
          }
        : {
            type: 'wording_choice',
            constraints: { options: opts, multiple: true },
            why: `${opts.length} filed alternatives; one or more may be selected.`,
          },
    });
  }

  for (const s of all) {
    if (used.has(s)) continue;
    const full = text.slice(s.start, s.end);
    if (s.kind === 'placeholder') {
      out.push({
        ...s,
        text: full,
        page: pageOf(pageStarts, s.start),
        suggestion: placeholderSuggestion(full),
      });
      continue;
    }
    const inner = full.slice(1, -1);
    if (/^\s*optional\s*$/i.test(inner)) continue; // the [Optional] marker itself
    out.push({
      start: s.start,
      end: s.end,
      depth: s.depth,
      text: full,
      page: pageOf(pageStarts, s.start),
      suggestion: suggest(inner, text.slice(s.end, s.end + 20)),
    });
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}
