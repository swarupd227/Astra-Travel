import type { CatalogueDocument, PlanDocument, Timing } from '@astra/contracts';

/**
 * Coverage dates, the annual term, review period and benefit limits (E05-F03, E05-F01-S01). Times are local
 * date-times as the forms state them (no time zone): `2026-11-22T00:01`. The departure instant is the start
 * of the departure date. Design: docs/adr/0010.
 */

export class CoverageError extends Error {
  constructor(
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'CoverageError';
  }
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const parse = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s}:00Z`);
const format = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export const addDays = (date: string, days: number): string => format(parse(date) + days * DAY).slice(0, 10);

export interface TripDates {
  purchaseDate: string;
  departureDate: string;
  returnDate: string;
}

export function coverageWindow(timing: Timing, trip: TripDates): { start: string; end: string } {
  const start =
    timing.start.kind === 'day_after_premium_received'
      ? `${addDays(trip.purchaseDate, 1)}T00:01`
      : timing.start.kind === 'purchase_date'
        ? `${trip.purchaseDate}T00:01`
        : `${trip.departureDate}T00:01`;
  const end =
    timing.end.kind === 'return_date'
      ? `${trip.returnDate}T23:59`
      : timing.end.kind === 'departure'
        ? `${trip.departureDate}T00:00`
        : format(parse(trip.departureDate) - timing.end.hours * 3_600_000);
  if (end <= start) throw new CoverageError(`Cover would end (${end.replace('T', ' ')}) before it starts (${start.replace('T', ' ')}).`);
  return { start, end };
}

/** The timing that applies to a benefit: its own, else its benefit group's. */
export function timingFor(doc: PlanDocument, benefit: string, group: string): Timing | null {
  return doc.timing[benefit] ?? doc.timing[group] ?? null;
}

/** The end of an annual term: 11:59 p.m. on the 364th day after the effective date (E05-F03-S03). */
export const annualTermEnd = (effectiveDate: string): string => `${addDays(effectiveDate, 364)}T23:59`;

/** The review period ends at 11:59 p.m. the given number of days after the purchase date. */
export const reviewPeriodEnd = (purchasedOn: string, days: number): string => `${addDays(purchasedOn, days)}T23:59`;

export interface BenefitCoverage {
  start: string;
  end: string;
}

/**
 * Cover dates for each benefit of a plan. An annual policy's benefits are cut off at the end of the term;
 * the policy term runs from the earliest start of its benefits.
 */
export function policyCoverage(
  doc: PlanDocument,
  cat: CatalogueDocument,
  benefits: string[],
  trip: TripDates,
  term: 'single_trip' | 'annual',
): { perBenefit: Record<string, BenefitCoverage>; term: { start: string; end: string } } {
  const perBenefit: Record<string, BenefitCoverage> = {};
  for (const code of benefits) {
    const b = cat.benefits.find((x) => x.code === code);
    if (!b) throw new CoverageError(`The catalogue has no benefit ${code}.`);
    const t = timingFor(doc, code, b.group);
    if (!t) throw new CoverageError(`The plan has no coverage timing for ${b.name} (benefit group ${b.group.replace(/_/g, ' ')}), so its cover dates cannot be set.`, `timing.${b.group}`);
    perBenefit[code] = coverageWindow(t, trip);
  }
  const starts = Object.values(perBenefit).map((c) => c.start).sort();
  const ends = Object.values(perBenefit).map((c) => c.end).sort();
  if (starts.length === 0) throw new CoverageError('The policy has no benefits.');
  const start = starts[0]!;
  let end = ends.at(-1)!;
  if (term === 'annual') {
    const termEnd = annualTermEnd(start.slice(0, 10));
    // Trips that run past the term end are covered to the earliest end event the form defines.
    for (const c of Object.values(perBenefit)) if (c.end > termEnd) c.end = termEnd;
    end = termEnd;
  }
  return { perBenefit, term: { start, end } };
}

/** The filed limit of a benefit as the plan's values give it: its maximum amount and basis. */
export function benefitLimits(doc: PlanDocument, cat: CatalogueDocument, code: string): { maximum: number | null; basis: string | null } {
  const b = cat.benefits.find((x) => x.code === code);
  if (!b?.maximum) return { maximum: null, basis: null };
  const key = (r: { source: string; key: string }) => `${r.source}:${r.key}`;
  const v = doc.values[key(b.maximum.variable)];
  const basis = b.maximum.basis.kind === 'fixed' ? b.maximum.basis.basis.replace(/_/g, ' ') : (() => {
    const x = doc.values[key(b.maximum!.basis.kind === 'variable' ? b.maximum!.basis.variable : { source: '', key: '' })];
    return typeof x === 'string' ? x : null;
  })();
  return { maximum: typeof v === 'number' ? v : null, basis };
}
