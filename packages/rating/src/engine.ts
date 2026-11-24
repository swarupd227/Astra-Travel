import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type {
  ManualDocument,
  RatingInput,
  RatingRequest,
  RatingResult,
  RatingTable,
  WorksheetStep,
} from '@astra/contracts';
import { RATING_INPUT_LABELS } from '@astra/contracts';
import { canonicalJson } from '@astra/platform';

/**
 * The rating engine (M2). Evaluates a filed manual for one traveller and one benefit:
 * base loss cost x trip cost factor x rating variables (including the peril package and exclusion
 * waivers) + supplemental benefits, then the loss cost multiplier, rounding and minimum premium.
 * Deterministic: the same manual version and inputs always give the same worksheet.
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

export class RatingError extends Error {
  constructor(
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'RatingError';
  }
}

export interface ManualForRating {
  id: string;
  code: string;
  version: number;
  benefit: string;
  state: string;
  illustrative: boolean;
  document: ManualDocument;
}

type Value = string | number | boolean | null;
export type RatingValues = Record<RatingInput, Value>;

const DAY = 86_400_000;
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

class Sheet {
  readonly steps: WorksheetStep[] = [];
  add(
    step: string,
    label: string,
    value: Dec | string,
    extra: Partial<Pick<WorksheetStep, 'table' | 'band' | 'page' | 'note'>> = {},
  ) {
    this.steps.push({
      step,
      label,
      value: typeof value === 'string' ? value : value.toString(),
      table: extra.table ?? null,
      band: extra.band ?? null,
      page: extra.page ?? null,
      note: extra.note ?? null,
    });
  }
}

/** Derived inputs (E02-F04-S02, E02-F04-S03), each recorded on the worksheet. */
export function deriveInputs(req: RatingRequest, sheet?: Sheet): RatingValues {
  const t = req.trip;
  const note = (step: string, label: string, value: Value, how: string) =>
    sheet?.add(step, label, String(value ?? 'not given'), { note: how });

  let tripCost: Dec;
  if (t.costPerTraveller !== undefined) {
    tripCost = new D(t.costPerTraveller);
    note('input.tripCost', 'Trip cost per traveller', tripCost.toString(), 'As given');
  } else {
    tripCost = new D(t.reservationTotal!).div(t.travellers!);
    note(
      'input.tripCost',
      'Trip cost per traveller',
      tripCost.toString(),
      `Reservation total ${t.reservationTotal} divided by ${t.travellers} travellers`,
    );
  }

  const tripLength = days(t.departureDate, t.returnDate) + 1;
  if (tripLength < 1)
    throw new RatingError('The return date is before the departure date.', 'trip.returnDate');
  note(
    'derived.tripLength',
    'Trip length (days)',
    tripLength,
    'Return date minus departure date plus one',
  );

  const before = days(t.purchaseDate, t.departureDate);
  if (before < 0)
    throw new RatingError('The purchase date is after the departure date.', 'trip.purchaseDate');
  note(
    'derived.daysBeforeDeparture',
    'Days before departure at purchase',
    before,
    'Departure date minus purchase date',
  );

  const month = Number(t.departureDate.slice(5, 7));
  note('derived.departureMonth', 'Departure month', month, 'Month of the departure date');

  let waiverDays: number | null = null;
  if (t.initialDepositDate) {
    waiverDays = days(t.initialDepositDate, t.purchaseDate);
    if (waiverDays < 0)
      throw new RatingError(
        'The initial deposit date is after the purchase date.',
        'trip.initialDepositDate',
      );
    note(
      'derived.waiverPeriodDays',
      'Days from initial deposit to purchase',
      waiverDays,
      'Purchase date minus initial deposit date',
    );
  }

  let region: string | null = null;
  let scope: string | null = null;
  if (t.destinations.length) {
    // The primary destination is the one with the most travel days; on a tie, the first listed.
    const primary = t.destinations.reduce((a, b) => (b.days > a.days ? b : a));
    region = primary.region ?? null;
    scope = primary.scope ?? null;
    note(
      'derived.primaryDestination',
      'Primary destination',
      region ?? scope ?? 'unknown',
      t.destinations.length > 1
        ? `Most travel days (${primary.days}) of ${t.destinations.length} destinations`
        : 'Only destination',
    );
  }

  return {
    age: req.traveller.age ?? null,
    preExistingWaived: req.traveller.preExistingWaived ?? null,
    waiverPeriodDays: waiverDays,
    lookbackDays: req.plan.lookbackDays ?? null,
    tripCost: tripCost.toString(),
    tripLength,
    departureMonth: month,
    daysBeforeDeparture: before,
    destinationRegion: region,
    destinationScope: scope,
    businessSegment: req.account.businessSegment ?? null,
    packageType: req.plan.packageType,
    penaltyDays: t.penaltyDays ?? null,
    productType: req.plan.productType ?? null,
  };
}

export interface Lookup {
  factor: Dec;
  band: string;
  how: 'row' | 'unused' | 'unknown';
  why: string | null;
}

/**
 * Looks up a factor (E02-F02-S01..S03). Band keys match the highest lower bound the value meets; exact
 * keys match equal values. A variable the account does not collect uses the table's unused factor; a
 * collected but missing or unmatched value uses its unknown factor; otherwise the lookup fails.
 */
export function lookup(
  table: RatingTable,
  values: RatingValues,
  notCollected: readonly RatingInput[],
): Lookup {
  const missing = table.keys.find((k) => notCollected.includes(k.input as RatingInput));
  if (missing) {
    if (table.unused === null) {
      throw new RatingError(
        `Table ${table.id} has no unused factor, but the account does not collect ${labelOf(missing.input).toLowerCase()}.`,
        missing.input,
      );
    }
    return {
      factor: new D(table.unused),
      band: 'unused',
      how: 'unused',
      why: `The account does not collect ${labelOf(missing.input).toLowerCase()}`,
    };
  }
  const unknown = (why: string, field: string): Lookup => {
    if (table.unknown === null)
      throw new RatingError(`${why} (table ${table.id}, page ${table.page}).`, field);
    return { factor: new D(table.unknown), band: 'unknown', how: 'unknown', why };
  };

  let rows = table.rows;
  const bandText: string[] = [];
  for (const [i, key] of table.keys.entries()) {
    const value = (values as Record<string, Value>)[key.input];
    const label = labelOf(key.input);
    if (value === null || value === undefined) return unknown(`${label} is not given`, key.input);
    if (key.match === 'exact') {
      rows = rows.filter((r) => String(r.keys[i]) === String(value));
      if (!rows.length)
        return unknown(`No row for ${label.toLowerCase()} ${String(value)}`, key.input);
      bandText.push(String(value));
    } else {
      const v = new D(String(value));
      const bounds = [...new Set(rows.map((r) => String(r.keys[i])))]
        .map((b) => new D(b))
        .filter((b) => b.lte(v));
      if (!bounds.length)
        return unknown(`${label} ${String(value)} is below the lowest band`, key.input);
      const best = bounds.reduce((a, b) => (b.gt(a) ? b : a));
      rows = rows.filter((r) => new D(String(r.keys[i])).eq(best));
      bandText.push(`from ${best.toString()}`);
    }
  }
  if (rows.length !== 1)
    throw new RatingError(
      `Table ${table.id} has ${rows.length} rows for these keys; it must have exactly one.`,
      null,
    );
  return { factor: new D(rows[0]!.factor), band: bandText.join(', '), how: 'row', why: null };
}

const labelOf = (input: string) => (RATING_INPUT_LABELS as Record<string, string>)[input] ?? input;

function tableById(doc: ManualDocument, id: string): RatingTable {
  const t = doc.tables.find((x) => x.id === id);
  if (!t) throw new RatingError(`The manual refers to table ${id}, which it does not contain.`);
  return t;
}

export function inputsHash(
  manual: Pick<ManualForRating, 'id' | 'version'>,
  req: RatingRequest,
): string {
  return createHash('sha256')
    .update(canonicalJson({ manual: manual.id, version: manual.version, request: req }))
    .digest('hex');
}

export function rate(manual: ManualForRating, req: RatingRequest): RatingResult {
  const doc = manual.document;
  const sheet = new Sheet();
  const values = deriveInputs(req, sheet);
  const notCollected = req.account.notCollected;

  // Trip cost and the minimum trip cost rule (E02-F02-S04).
  let tripCost = new D(values.tripCost as string);
  if (tripCost.isZero()) {
    throw new RatingError(
      'A trip cost of $0 is not rated: how the manual and plan treat it is to be confirmed with Assurant.',
      'trip.costPerTraveller',
    );
  }
  if (tripCost.isNegative())
    throw new RatingError('The trip cost cannot be negative.', 'trip.costPerTraveller');
  const min = doc.minimumTripCost;
  if (min && tripCost.gte(min.from) && tripCost.lte(min.to)) {
    sheet.add('rule.minimumTripCost', 'Minimum trip cost rule', min.ratesAs, {
      note: `Trip costs from ${min.from} to ${min.to} rate as ${min.ratesAs}`,
    });
    tripCost = new D(min.ratesAs);
    values.tripCost = tripCost.toString();
  }

  // Base loss cost x trip cost factor (E02-F03-S01).
  const base = new D(doc.baseLossCost);
  sheet.add('formula.baseLossCost', 'Base loss cost per $100 of trip cost', base);
  const exposure = tableById(doc, doc.exposure.table);
  const ex = lookup(exposure, values, notCollected);
  sheet.add(`table.${exposure.id}`, exposure.name, ex.factor, {
    table: exposure.id,
    band: ex.band,
    page: exposure.page,
    note: ex.why,
  });
  const tripCostFactor = tripCost.div(100).mul(ex.factor);
  sheet.add('formula.tripCostFactor', 'Trip cost factor', tripCostFactor, {
    note: `${tripCost.toString()} / 100 x ${ex.factor.toString()}`,
  });

  // Rating variables, multiplied.
  let product = new D(1);
  for (const v of doc.variables) {
    // Alternatives (for example region or domestic/international): the first whose input the account collects.
    const chosen =
      v.tables
        .map((id) => tableById(doc, id))
        .find((t) => !t.keys.some((k) => notCollected.includes(k.input as RatingInput))) ??
      tableById(doc, v.tables[0]!);
    const l = lookup(chosen, values, notCollected);
    product = product.mul(l.factor);
    sheet.add(`table.${chosen.id}`, v.label, l.factor, {
      table: chosen.id,
      band: l.band,
      page: chosen.page,
      note: l.why,
    });
  }

  // Peril package: the sum of the percentages of each covered reason and coverage level (E02-F03-S03).
  if (doc.perilPackage) {
    if (!req.plan.perils.length) {
      throw new RatingError(
        'The plan covers no reasons, so the peril package factor would be zero. Choose the covered reasons.',
        'plan.perils',
      );
    }
    const t = tableById(doc, doc.perilPackage.table);
    const productKey = t.keys.length > 2;
    let sum = new D(0);
    for (const p of req.plan.perils) {
      for (const level of p.levels) {
        const match = (product: string | null) =>
          t.rows.find(
            (r) =>
              String(r.keys[0]) === p.peril &&
              String(r.keys[1]) === level &&
              (!productKey || String(r.keys[2]) === (product ?? '*')),
          );
        const row =
          (productKey && values.productType ? match(String(values.productType)) : undefined) ??
          match(productKey ? '*' : null);
        if (!row)
          throw new RatingError(
            `Table ${t.id} has no factor for peril ${p.peril} at level ${level}.`,
            'plan.perils',
          );
        sum = sum.plus(row.factor);
        sheet.add(
          `peril.${p.peril}.${level}`,
          `Peril ${p.peril}, ${level.replace(/_/g, ' ')}`,
          `${row.factor}%`,
          {
            table: t.id,
            page: t.page,
            note: productKey && row.keys[2] !== '*' ? `Product type ${String(row.keys[2])}` : null,
          },
        );
      }
    }
    const factor = sum.div(100);
    product = product.mul(factor);
    sheet.add('formula.perilPackage', 'Peril package factor', factor, {
      table: t.id,
      page: t.page,
      note: `Sum of ${sum.toString()}% over the covered reasons`,
    });
  }

  // Removal of exclusions, with the maximum combined factor (E02-F03-S04).
  if (doc.exclusionWaivers && req.plan.waivedExclusions.length) {
    const t = tableById(doc, doc.exclusionWaivers.table);
    let combined = new D(1);
    for (const code of req.plan.waivedExclusions) {
      const row = t.rows.find((r) => String(r.keys[0]) === code);
      if (!row)
        throw new RatingError(
          `Table ${t.id} has no factor for waiving ${code}.`,
          'plan.waivedExclusions',
        );
      combined = combined.mul(row.factor);
      sheet.add(`waiver.${code}`, `Removal of exclusion ${code}`, row.factor, {
        table: t.id,
        page: t.page,
      });
    }
    const max = new D(doc.exclusionWaivers.maxCombined);
    const capped = D.min(combined, max);
    product = product.mul(capped);
    sheet.add('formula.waivers', 'Combined removal of exclusions factor', capped, {
      table: t.id,
      page: t.page,
      note: combined.gt(max)
        ? `Product ${combined.toString()} capped at the filed maximum ${max.toString()}`
        : null,
    });
  }

  sheet.add('formula.variables', 'Product of rating variables', product);
  let lossCost = base.mul(tripCostFactor).mul(product);
  sheet.add(
    'formula.ratedLossCost',
    'Base loss cost x trip cost factor x rating variables',
    lossCost,
  );

  // Supplemental benefits: per $100 below the threshold, a flat amount at or above it (E02-F03-S05).
  for (const s of req.plan.supplemental) {
    const def = doc.supplemental.find((x) => x.code === s.code);
    if (!def)
      throw new RatingError(
        `The manual has no supplemental benefit ${s.code}.`,
        'plan.supplemental',
      );
    const amount = new D(s.amount);
    const add = amount.lt(def.threshold) ? amount.div(100).mul(def.perHundred) : new D(def.flat);
    lossCost = lossCost.plus(add);
    sheet.add(`supplemental.${s.code}`, def.name, add, {
      page: def.page,
      note: amount.lt(def.threshold)
        ? `${amount.toString()} / 100 x ${def.perHundred}`
        : `Flat amount for ${def.threshold} or more`,
    });
  }
  sheet.add('formula.lossCost', 'Loss cost', lossCost);

  // Conversion to a rate (E02-F03-S02).
  const c = doc.conversion;
  let amount = lossCost;
  let kind: RatingResult['kind'] = 'loss_cost';
  if (c.lossCostMultiplier) {
    amount = amount.mul(c.lossCostMultiplier);
    kind = 'premium';
    sheet.add('formula.lossCostMultiplier', 'Loss cost multiplier', c.lossCostMultiplier);
  } else {
    sheet.add('formula.lossCostMultiplier', 'Loss cost multiplier', 'not filed', {
      note: 'No multiplier is configured: the result is a loss cost, not a premium',
    });
  }
  amount = amount.toDecimalPlaces(c.roundTo, Decimal.ROUND_HALF_UP);
  sheet.add('formula.rounded', `Rounded to ${c.roundTo} decimal places`, amount.toFixed(c.roundTo));
  if (kind === 'premium' && c.minimumPremium && amount.lt(c.minimumPremium)) {
    amount = new D(c.minimumPremium);
    sheet.add('formula.minimumPremium', 'Minimum premium applied', amount.toFixed(c.roundTo));
  }

  return {
    kind,
    amount: amount.toFixed(c.roundTo),
    illustrative: manual.illustrative,
    manual: {
      id: manual.id,
      code: manual.code,
      version: manual.version,
      benefit: manual.benefit,
      state: manual.state,
    },
    inputsHash: inputsHash(manual, req),
    steps: sheet.steps,
  };
}
