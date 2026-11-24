import type { EvaluationResult, RuleTestCase } from '@astra/contracts';

/** Compares an evaluation with what a rule set test case expects (E03-F05-S02); every difference is listed. */
export function checkExpectation(expected: RuleTestCase['expected'], r: EvaluationResult): string[] {
  const misses: string[] = [];
  if (r.outcome !== expected.outcome) misses.push(`outcome ${r.outcome}, expected ${expected.outcome}`);
  if (expected.referralRules) {
    const fired = r.referrals.map((x) => x.rule).sort().join(', ') || 'none';
    const want = [...expected.referralRules].sort().join(', ') || 'none';
    if (fired !== want) misses.push(`referral rules ${fired}, expected ${want}`);
  }
  if (expected.waiver !== undefined && r.waiver.applies !== expected.waiver) misses.push(`waiver ${r.waiver.applies ? 'applies' : 'does not apply'}, expected ${expected.waiver ? 'applies' : 'does not apply'}`);
  if (expected.cfarOffered !== undefined && r.cfar.offered !== expected.cfarOffered) misses.push(`CFAR ${r.cfar.offered ? 'offered' : 'not offered'}, expected ${expected.cfarOffered ? 'offered' : 'not offered'}`);
  for (const text of expected.reasonsInclude ?? []) {
    if (!r.reasons.some((x) => x.includes(text))) misses.push(`no reason contains “${text}”`);
  }
  return misses;
}
