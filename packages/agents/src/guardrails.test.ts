import { describe, expect, it } from 'vitest';
import { luhnValid, redact, redactValue } from './guardrails';

describe('guardrails', () => {
  it('validates card numbers with the Luhn check', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it('removes Luhn-valid card numbers in any common format and keeps only the last four', () => {
    for (const card of [
      '4111111111111111',
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      '378282246310005',
    ]) {
      const r = redact(`Card ${card} was used.`);
      expect(r.text).not.toMatch(/\d{6,}/);
      expect(r.findings).toEqual([
        { kind: 'payment_card', hint: card.replace(/\D/g, '').slice(-4) },
      ]);
    }
  });

  it('leaves identifiers that are not card numbers alone', () => {
    const text =
      'Event 1795084608401 and UUID 7d1f6c2a-3b4e-4f5a-8b6c-9d0e1f2a3b01, trip cost 4200.';
    expect(redact(text)).toEqual({ text, findings: [] });
  });

  it('removes social security numbers but not numbers the SSA never issues', () => {
    expect(redact('SSN 123-45-6789').findings).toHaveLength(1);
    expect(redact('SSN 000-12-3456').findings).toHaveLength(0);
    expect(redact('SSN 666-12-3456').findings).toHaveLength(0);
    expect(redact('Date 2026-11-19').findings).toHaveLength(0);
  });

  it('redacts inside nested tool results', () => {
    const r = redactValue({
      items: [{ name: 'Pat', note: 'paid with 4111 1111 1111 1111' }],
      count: 1,
    });
    expect(JSON.stringify(r.value)).not.toContain('4111 1111');
    expect(r.findings).toHaveLength(1);
  });
});
