/** A small seeded random source, so a run can be repeated and read about. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const chance = (p: number) => next() < p;
  const weighted = <T>(items: readonly T[], weight: (item: T) => number): T => {
    const total = items.reduce((a, i) => a + weight(i), 0);
    let r = next() * total;
    for (const item of items) {
      r -= weight(item);
      if (r <= 0) return item;
    }
    return items[items.length - 1]!;
  };
  return { next, int, pick, chance, weighted };
}
export type Random = ReturnType<typeof seeded>;
