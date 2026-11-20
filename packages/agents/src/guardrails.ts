/**
 * Guardrails as policy code (E15-F02-S03). Runs on what a person asks, on everything the model writes,
 * and on every tool result, before anything crosses a boundary.
 *
 * Sensitive data detected today:
 * - payment card numbers (13 to 19 digits, spaces or hyphens allowed, Luhn-valid), which must never be
 *   stored or shown (specification M18 business rules, PCI DSS);
 * - US social security numbers in the 3-2-4 format, excluding numbers the SSA never issues.
 */

export type SensitiveKind = 'payment_card' | 'us_ssn';

export interface Finding {
  kind: SensitiveKind;
  /** Last four digits only; the full value is never kept. */
  hint: string;
}

const CARD_CANDIDATE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
const SSN_CANDIDATE = /(?<!\d)(\d{3})-(\d{2})-(\d{4})(?!\d)/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function plausibleSsn(area: string, group: string, serial: string): boolean {
  const a = Number(area);
  return a !== 0 && a !== 666 && a < 900 && group !== '00' && serial !== '0000';
}

/** Returns the text with sensitive values replaced, and what was found. */
export function redact(text: string): { text: string; findings: Finding[] } {
  const findings: Finding[] = [];
  let out = text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    findings.push({ kind: 'payment_card', hint: digits.slice(-4) });
    return `[card number removed, ending ${digits.slice(-4)}]`;
  });
  out = out.replace(SSN_CANDIDATE, (match, area: string, group: string, serial: string) => {
    if (!plausibleSsn(area, group, serial)) return match;
    findings.push({ kind: 'us_ssn', hint: serial });
    return '[social security number removed]';
  });
  return { text: out, findings };
}

/** Redacts every string inside a JSON value (tool results). */
export function redactValue(value: unknown): { value: unknown; findings: Finding[] } {
  const findings: Finding[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redact(v);
      findings.push(...r.findings);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value), findings };
}
