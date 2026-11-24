import Decimal from 'decimal.js';
import { RatingRequestSchema, type RatingRequest } from '@astra/contracts';
import { parseCsv } from '@astra/studio';
import { rate, RatingError, type ManualForRating } from './engine';

/**
 * Workbook parity (E02-F07-S02). Each case is a rating request with the expected amount and, optionally,
 * expected factors by worksheet step. A manual cannot be published unless every case matches to the cent.
 */

export interface ParityCaseInput {
  name: string;
  request: RatingRequest;
  expectedAmount: string;
  /** Worksheet step id (for example `table.2.1.5`) to expected value. */
  expectedFactors: Record<string, string>;
  /** The row of the imported file (the header is row 1), so an explanation can cite the workbook cell. */
  sourceRow?: number;
}

export interface ParityResult {
  name: string;
  passed: boolean;
  expectedAmount: string;
  actualAmount: string | null;
  error: string | null;
  factorDifferences: { step: string; expected: string; actual: string | null }[];
}

const same = (a: string, b: string) => {
  try {
    return new Decimal(a.replace('%', '')).eq(b.replace('%', ''));
  } catch {
    return a === b;
  }
};

export function runCase(manual: ManualForRating, c: ParityCaseInput): ParityResult {
  try {
    const r = rate(manual, c.request);
    const factorDifferences = Object.entries(c.expectedFactors)
      .map(([step, expected]) => {
        const actual = r.steps.find((s) => s.step === step)?.value ?? null;
        return { step, expected, actual };
      })
      .filter((d) => d.actual === null || !same(d.expected, d.actual));
    // To the cent: compare at two decimal places.
    const amountMatches =
      new Decimal(r.amount).toFixed(2) === new Decimal(c.expectedAmount).toFixed(2);
    return {
      name: c.name,
      passed: amountMatches && factorDifferences.length === 0,
      expectedAmount: c.expectedAmount,
      actualAmount: r.amount,
      error: null,
      factorDifferences,
    };
  } catch (err) {
    if (!(err instanceof RatingError)) throw err;
    return {
      name: c.name,
      passed: false,
      expectedAmount: c.expectedAmount,
      actualAmount: null,
      error: err.message,
      factorDifferences: [],
    };
  }
}

const COLUMNS = [
  'name',
  'expected_amount',
  'age',
  'pre_existing_waived',
  'cost_per_traveller',
  'reservation_total',
  'travellers',
  'purchase_date',
  'departure_date',
  'return_date',
  'initial_deposit_date',
  'destination_region',
  'destination_scope',
  'business_segment',
  'not_collected',
  'package_type',
  'lookback_days',
  'penalty_days',
  'product_type',
  'perils',
  'waived_exclusions',
  'supplemental',
] as const;

export interface CsvProblem {
  row: number;
  message: string;
}

/**
 * Reads parity cases from a CSV export of a workbook. One row per case; columns as named in COLUMNS, plus
 * any number of `factor:<worksheet step>` columns for expected factors. Lists use `;`; perils are written
 * `PERIL:level|level;PERIL2:level` and supplemental benefits `code:amount`.
 */
export function parseParityCsv(
  text: string,
  base: { state: string; benefit: string; rateDate: string },
): { cases: ParityCaseInput[]; problems: CsvProblem[] } {
  const rows = parseCsv(text);
  const problems: CsvProblem[] = [];
  const cases: ParityCaseInput[] = [];
  if (rows[0]) {
    const unknown = Object.keys(rows[0]).filter(
      (k) => !(COLUMNS as readonly string[]).includes(k) && !k.startsWith('factor:'),
    );
    if (unknown.length)
      problems.push({ row: 1, message: `Unknown columns: ${unknown.join(', ')}` });
  }
  const list = (v: string | undefined) =>
    v
      ? v
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));
  rows.forEach((r, i) => {
    const line = i + 2;
    const draft = {
      ...base,
      traveller: {
        age: num(r.age),
        preExistingWaived:
          r.pre_existing_waived === '' || r.pre_existing_waived === undefined
            ? null
            : r.pre_existing_waived.toLowerCase() === 'true',
      },
      trip: {
        ...(r.cost_per_traveller ? { costPerTraveller: r.cost_per_traveller } : {}),
        ...(r.reservation_total
          ? { reservationTotal: r.reservation_total, travellers: num(r.travellers) ?? undefined }
          : {}),
        purchaseDate: r.purchase_date,
        departureDate: r.departure_date,
        returnDate: r.return_date,
        initialDepositDate: r.initial_deposit_date || null,
        destinations:
          r.destination_region || r.destination_scope
            ? [
                {
                  region: r.destination_region || null,
                  scope: (r.destination_scope || null) as 'domestic' | 'international' | null,
                  days: 1,
                },
              ]
            : [],
        penaltyDays: num(r.penalty_days),
      },
      account: { businessSegment: r.business_segment || null, notCollected: list(r.not_collected) },
      plan: {
        packageType: r.package_type,
        lookbackDays: num(r.lookback_days),
        productType: r.product_type || null,
        perils: list(r.perils).map((p) => {
          const [peril, levels = ''] = p.split(':');
          return {
            peril: peril!.trim(),
            levels: levels
              .split('|')
              .map((l) => l.trim())
              .filter(Boolean),
          };
        }),
        waivedExclusions: list(r.waived_exclusions),
        supplemental: list(r.supplemental).map((s) => {
          const [code, amount] = s.split(':');
          return { code: code!.trim(), amount: (amount ?? '').trim() };
        }),
      },
    };
    const parsed = RatingRequestSchema.safeParse(draft);
    if (!parsed.success) {
      problems.push({
        row: line,
        message: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '),
      });
      return;
    }
    if (!r.name) problems.push({ row: line, message: 'Each case needs a name.' });
    if (!r.expected_amount || Number.isNaN(Number(r.expected_amount))) {
      problems.push({ row: line, message: 'expected_amount must be a number.' });
      return;
    }
    cases.push({
      name: r.name ?? `Row ${line}`,
      request: parsed.data,
      expectedAmount: r.expected_amount,
      sourceRow: line,
      expectedFactors: Object.fromEntries(
        Object.entries(r)
          .filter(([k, v]) => k.startsWith('factor:') && v !== '')
          .map(([k, v]) => [k.slice(7), v]),
      ),
    });
  });
  return { cases, problems };
}
