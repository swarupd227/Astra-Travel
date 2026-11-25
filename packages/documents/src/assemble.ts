import { dollars, numberToWords, withCommas, wordsAndFigures } from './words';

/**
 * Assembly of a filed form (E09-F01-S01): the form's text with each bracketed option and value replaced by the
 * plan's value in the filed format, and unselected optional benefits removed. It never guesses: a variable
 * with no value, or any bracket left in the result, is a problem. Design: docs/adr/0011.
 */

export interface AssemblyVariable {
  /** `schedule:key` or `policy:key`, as plan values are keyed. */
  ref: string;
  label: string;
  type: string;
  constraints: Record<string, unknown>;
  start: number;
  end: number;
  excerpt: string;
}

export type ResolvedValue = boolean | number | string | string[] | { percent: number; basis?: string | undefined } | null | undefined;

export interface AssemblyProblem {
  variable: string | null;
  message: string;
}

export interface AssemblyResult {
  text: string;
  problems: AssemblyProblem[];
  /** Variables whose values were inserted. */
  inserted: string[];
  /** Optional benefits left out, by variable. */
  removed: string[];
}

interface Node {
  v: AssemblyVariable;
  children: Node[];
}

function tree(variables: AssemblyVariable[], problems: AssemblyProblem[]): Node[] {
  const sorted = [...variables].sort((a, b) => a.start - b.start || b.end - a.end);
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const v of sorted) {
    while (stack.length && stack.at(-1)!.v.end <= v.start) stack.pop();
    const parent = stack.at(-1);
    if (parent && v.end > parent.v.end) {
      problems.push({ variable: v.ref, message: `${v.label} overlaps ${parent.v.label} without being inside it, so the form cannot be assembled.` });
      continue;
    }
    const node: Node = { v, children: [] };
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

/** What follows the last closing parenthesis inside a bracket: the unit the form prints with the figures. */
const suffixOf = (excerpt: string): string => {
  const inner = excerpt.slice(1, -1);
  const at = inner.lastIndexOf(')');
  return at >= 0 ? inner.slice(at + 1) : '';
};

function format(v: AssemblyVariable, value: ResolvedValue): string | null {
  const c = v.constraints;
  switch (v.type) {
    case 'numeric_range':
      if (typeof value !== 'number') return null;
      return c.unit === 'usd' ? dollars(value) : withCommas(value);
    case 'time_period':
      if (typeof value !== 'number' || !Number.isInteger(value)) return null;
      return `${wordsAndFigures(value)}${suffixOf(v.excerpt)}`;
    case 'percentage_range': {
      const n = typeof value === 'number' ? value : value && typeof value === 'object' && !Array.isArray(value) ? value.percent : null;
      if (n === null || !Number.isInteger(n)) return null;
      const basis = value && typeof value === 'object' && !Array.isArray(value) && value.basis ? ` ${value.basis}` : '';
      return `${numberToWords(n)} percent (${n}%)${basis}${suffixOf(v.excerpt)}`;
    }
    case 'limit_basis':
      return typeof value === 'string' ? value : null;
    case 'wording_choice':
      return Array.isArray(value) && value.length ? value.join(', ') : typeof value === 'string' ? value : null;
    case 'insert_placeholder':
      return typeof value === 'string' && value.length ? value : null;
    default:
      return null;
  }
}

export function assemble(text: string, variables: AssemblyVariable[], values: Map<string, ResolvedValue>): AssemblyResult {
  const problems: AssemblyProblem[] = [];
  const inserted: string[] = [];
  const removed: string[] = [];

  const renderRange = (from: number, to: number, nodes: Node[]): string => {
    let out = '';
    let at = from;
    for (const n of nodes) {
      out += text.slice(at, n.v.start);
      const r = renderNode(n);
      if (r === null) {
        // A removed optional benefit: if it filled its line, its line break goes too.
        const lineStart = n.v.start === 0 || text[n.v.start - 1] === '\n';
        at = lineStart && text[n.v.end] === '\n' ? n.v.end + 1 : n.v.end;
      } else {
        out += r;
        at = n.v.end;
      }
    }
    return out + text.slice(at, to);
  };

  const renderNode = (n: Node): string | null => {
    const v = n.v;
    const value = values.get(v.ref);
    if (v.type === 'optional_benefit') {
      if (value !== true) {
        removed.push(v.ref);
        return null;
      }
      inserted.push(v.ref);
      const inner = renderRange(v.start + 1, v.end - 1, n.children);
      return inner.replace(/^\s*\[Optional\]\s*/i, '');
    }
    const f = format(v, value);
    if (f === null) {
      problems.push({ variable: v.ref, message: value === undefined || value === null ? `The plan gives no value for “${v.label}”.` : `The plan's value for “${v.label}” is not in a form this wording can take (${JSON.stringify(value)}).` });
      return v.excerpt;
    }
    inserted.push(v.ref);
    return f;
  };

  const out = renderRange(0, text.length, tree(variables, problems));
  // Nothing of the form's machinery may reach a traveller.
  for (const m of out.matchAll(/\[[^\]\n]{0,80}\]?|<<[^>\n]{0,80}>>?|[[\]]/g)) {
    const start = Math.max(0, m.index - 30);
    problems.push({ variable: null, message: `A bracket is left in the document: “…${out.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ')}…”.` });
    if (problems.length > 60) break;
  }
  return { text: out, problems, inserted, removed };
}
