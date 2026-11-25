import { fromCents, toCents } from '@astra/policies';

export { fromCents, toCents };

/** `cents` times a percent (up to four decimals), rounded half away from zero, in whole cents. */
export function mulPercent(cents: number, percent: number): number {
  const p = BigInt(Math.round(percent * 10_000));
  const c = BigInt(cents);
  const num = (c < 0n ? -c : c) * p;
  const rounded = (num + 500_000n) / 1_000_000n;
  return Number(c < 0n ? -rounded : rounded);
}

/**
 * Spreads `total` cents over `weights` in proportion, by largest remainder, so the parts always add up to the
 * total exactly. Weights are magnitudes; with no weight at all the first part takes everything.
 */
export function spread(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, w) => a + Math.abs(w), 0);
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * Math.abs(w)) / sum);
  const base = raw.map(Math.floor);
  let left = abs - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    base[i]! += 1;
    left -= 1;
  }
  return base.map((b) => sign * b);
}
