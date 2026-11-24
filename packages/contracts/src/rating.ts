import { z } from 'zod';

/**
 * Rate manuals and rating (M2, epic E02). A manual is data validated by these schemas; the engine in
 * @astra/rating evaluates it. Decimal values are strings so no precision is lost.
 */

const date = z.iso.date();
export const DecimalString = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, 'A decimal number, for example 1.4750');

/** The rating variables the engine knows: inputs from the quote, or derived from them. */
export const RATING_INPUTS = [
  'age',
  'preExistingWaived',
  'waiverPeriodDays',
  'lookbackDays',
  'tripCost',
  'tripLength',
  'departureMonth',
  'daysBeforeDeparture',
  'destinationRegion',
  'destinationScope',
  'businessSegment',
  'packageType',
  'penaltyDays',
  'productType',
] as const;
export type RatingInput = (typeof RATING_INPUTS)[number];

export const RATING_INPUT_LABELS: Record<RatingInput, string> = {
  age: 'Age',
  preExistingWaived: 'Pre-existing exclusion waived',
  waiverPeriodDays: 'Days from initial deposit to purchase',
  lookbackDays: 'Pre-existing lookback period (days)',
  tripCost: 'Trip cost per traveller',
  tripLength: 'Trip length (days)',
  departureMonth: 'Departure month',
  daysBeforeDeparture: 'Days before departure at purchase',
  destinationRegion: 'Destination region',
  destinationScope: 'Domestic or international',
  businessSegment: 'Business segment',
  packageType: 'Package type',
  penaltyDays: 'Days before departure when the 100% penalty starts',
  productType: 'Product type',
};

/** Keys of the peril and exclusion-waiver tables, which are read per covered reason or waived exclusion. */
export const SPECIAL_TABLE_KEYS = ['peril', 'coverageLevel', 'exclusion'] as const;

export const TableKeySchema = z.object({
  input: z.enum([...RATING_INPUTS, ...SPECIAL_TABLE_KEYS]),
  /** `band`: the highest lower bound the value meets; `exact`: equal value. */
  match: z.enum(['band', 'exact']),
});

export const RatingTableSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9.\-_]{1,32}$/, 'As numbered in the manual, for example 2.1.5'),
    name: z.string().trim().min(2).max(200),
    page: z.string().trim().min(1).max(60),
    keys: z.array(TableKeySchema).min(1).max(4),
    rows: z
      .array(
        z.object({
          keys: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
          factor: DecimalString,
        }),
      )
      .min(1),
    /** Applies when the account does not collect the variable. */
    unused: DecimalString.nullable().default(null),
    /** Applies when the variable is collected but its value is unknown. */
    unknown: DecimalString.nullable().default(null),
  })
  .refine((t) => t.rows.every((r) => r.keys.length === t.keys.length), {
    message: 'Every row needs one key per table key',
    path: ['rows'],
  });
export type RatingTable = z.infer<typeof RatingTableSchema>;

export const ManualDocumentSchema = z.object({
  /** Base loss cost per exposure unit (per $100 of trip cost for Trip Cancellation). */
  baseLossCost: DecimalString,
  exposure: z.object({
    kind: z.literal('per_100_trip_cost'),
    /** The banded per-$100 trip cost table. */
    table: z.string(),
  }),
  /** Trip costs from `from` to `to` rate as `ratesAs` (for example $1 to $500 rate as $500). */
  minimumTripCost: z
    .object({ from: DecimalString, to: DecimalString, ratesAs: DecimalString })
    .nullable()
    .default(null),
  /** Multiplicative rating variables, in the manual's order. `tables` lists alternatives: the first whose input is collected is used. */
  variables: z
    .array(
      z.object({ label: z.string().min(2).max(100), tables: z.array(z.string()).min(1).max(3) }),
    )
    .default([]),
  perilPackage: z
    .object({
      /** Table keyed by peril, coverage level and optionally product type, holding percentages. */
      table: z.string(),
    })
    .nullable()
    .default(null),
  exclusionWaivers: z
    .object({ table: z.string(), maxCombined: DecimalString })
    .nullable()
    .default(null),
  supplemental: z
    .array(
      z.object({
        code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
        name: z.string().min(2).max(100),
        perHundred: DecimalString,
        threshold: DecimalString,
        flat: DecimalString,
        page: z.string().min(1).max(60),
      }),
    )
    .default([]),
  tables: z.array(RatingTableSchema).min(1),
  conversion: z.object({
    /** Null until Assurant provides it: results are then loss costs, labelled as such. */
    lossCostMultiplier: DecimalString.nullable(),
    minimumPremium: DecimalString.nullable(),
    roundTo: z.number().int().min(0).max(6).default(2),
  }),
});
export type ManualDocument = z.infer<typeof ManualDocumentSchema>;

export const MANUAL_STATUSES = ['draft', 'approved', 'published', 'withdrawn'] as const;

export const RateManualSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  state: z.string(),
  benefit: z.string(),
  version: z.number().int(),
  status: z.enum(MANUAL_STATUSES),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  /** Illustrative manuals (estimated loadings) exist only outside production and can never be published. */
  illustrative: z.boolean(),
  source: z.string(),
  document: ManualDocumentSchema,
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  approvedBy: z.string().nullable(),
  publishedBy: z.string().nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RateManual = z.infer<typeof RateManualSchema>;

export const CreateManualRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9-]{3,39}$/, 'As filed, for example RETR-SP-VU-DE-0426'),
  state: z.string().regex(/^[A-Z]{2}$/),
  benefit: z
    .string()
    .trim()
    .regex(/^[A-Z]{2,8}$/, 'For example TCAN'),
  effectiveFrom: date,
  illustrative: z.boolean().default(false),
  source: z.string().trim().min(3).max(500),
  document: ManualDocumentSchema,
});

export const COVERAGE_LEVEL_KEYS = [
  'self',
  'family_member',
  'travelling_companion',
  'business_partner',
  'host_at_destination',
] as const;

/** What a quote supplies for one traveller and one benefit. Missing values use unused/unknown factors or fail. */
export const RatingRequestSchema = z.object({
  state: z.string().regex(/^[A-Z]{2}$/),
  benefit: z.string().regex(/^[A-Z]{2,8}$/),
  rateDate: date,
  traveller: z.object({
    age: z.number().int().min(0).max(120).nullable().optional(),
    preExistingWaived: z.boolean().nullable().optional(),
  }),
  trip: z
    .object({
      costPerTraveller: DecimalString.optional(),
      reservationTotal: DecimalString.optional(),
      travellers: z.number().int().min(1).max(50).optional(),
      purchaseDate: date,
      departureDate: date,
      returnDate: date,
      initialDepositDate: date.nullable().optional(),
      destinations: z
        .array(
          z.object({
            region: z.string().max(40).nullable().optional(),
            scope: z.enum(['domestic', 'international']).nullable().optional(),
            days: z.number().int().min(1),
          }),
        )
        .default([]),
      penaltyDays: z.number().int().min(0).max(1000).nullable().optional(),
    })
    .refine(
      (t) =>
        t.costPerTraveller !== undefined ||
        (t.reservationTotal !== undefined && t.travellers !== undefined),
      {
        message:
          'Give the cost per traveller, or the reservation total and the number of travellers',
        path: ['costPerTraveller'],
      },
    ),
  account: z.object({
    businessSegment: z.string().max(40).nullable().optional(),
    /** Variables the account does not collect: their tables' unused factors apply. */
    notCollected: z.array(z.enum(RATING_INPUTS)).default([]),
  }),
  plan: z.object({
    packageType: z.enum(['packaged', 'optional']),
    lookbackDays: z.number().int().min(0).max(365).nullable().optional(),
    productType: z.string().max(40).nullable().optional(),
    perils: z
      .array(
        z.object({
          peril: z.string().max(20),
          levels: z.array(z.enum(COVERAGE_LEVEL_KEYS)).min(1),
        }),
      )
      .default([]),
    waivedExclusions: z.array(z.string().max(40)).default([]),
    supplemental: z
      .array(z.object({ code: z.string().max(40), amount: DecimalString }))
      .default([]),
  }),
});
export type RatingRequest = z.infer<typeof RatingRequestSchema>;

export const WorksheetStepSchema = z.object({
  step: z.string(),
  label: z.string(),
  value: z.string(),
  table: z.string().nullable(),
  band: z.string().nullable(),
  page: z.string().nullable(),
  note: z.string().nullable(),
});
export type WorksheetStep = z.infer<typeof WorksheetStepSchema>;

export const RatingResultSchema = z.object({
  /** `premium` when a loss cost multiplier is filed; otherwise `loss_cost`. */
  kind: z.enum(['premium', 'loss_cost']),
  amount: z.string(),
  illustrative: z.boolean(),
  manual: z.object({
    id: z.uuid(),
    code: z.string(),
    version: z.number().int(),
    benefit: z.string(),
    state: z.string(),
  }),
  inputsHash: z.string(),
  steps: z.array(WorksheetStepSchema),
});
export type RatingResult = z.infer<typeof RatingResultSchema>;

export const ParityCaseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  source: z.string(),
  request: RatingRequestSchema,
  expectedAmount: z.string(),
  expectedFactors: z.record(z.string(), z.string()),
});

export const ParityRunSchema = z.object({
  manualId: z.uuid(),
  ranAt: z.iso.datetime({ offset: true }),
  total: z.number().int(),
  passed: z.number().int(),
  results: z.array(
    z.object({
      caseId: z.uuid(),
      name: z.string(),
      passed: z.boolean(),
      expectedAmount: z.string(),
      actualAmount: z.string().nullable(),
      error: z.string().nullable(),
      factorDifferences: z.array(
        z.object({ step: z.string(), expected: z.string(), actual: z.string().nullable() }),
      ),
    }),
  ),
});
export type ParityRun = z.infer<typeof ParityRunSchema>;
