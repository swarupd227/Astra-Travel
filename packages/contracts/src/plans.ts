import { z } from 'zod';
import { VariableRefSchema } from './catalogue';
import { COVERAGE_LEVELS } from './catalogue';
import { DecimalString, QuoteRatingRequestSchema } from './rating';

/** Plan builder and publishing (E01-F03, E01-F04). Design: docs/adr/0007. */

const date = z.iso.date();
const CODE = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

export const PLAN_KINDS = ['base', 'state', 'account'] as const;
export const PACKAGING = ['packaged', 'standalone_optional', 'optional_upgrade'] as const;
export const PACKAGING_LABELS: Record<(typeof PACKAGING)[number], string> = {
  packaged: 'Packaged',
  standalone_optional: 'Stand-alone optional',
  optional_upgrade: 'Optional upgrade',
};

/**
 * Named plan conditions and coverage timing (E01-F03-S02, E01-F03-S03). Each binds a form variable, so its
 * filed range applies; rules and documents read them by these names.
 */
export const PLAN_SETTINGS = [
  'review_period',
  'time_sensitive_period',
  'lookback_period',
  'cfar_percent',
  'cfar_basis',
  'cfar_trip_cost_cap',
  'cfar_notice_period',
  'interruption_limit_percent',
  'pre_departure_start',
  'pre_departure_end',
  'post_departure_start',
  'post_departure_end',
  'extension_early_departure',
  'extension_late_return',
  'extension_baggage',
  'extension_hospitalisation',
  'annual_term',
] as const;
export type PlanSetting = (typeof PLAN_SETTINGS)[number];

export const PLAN_SETTING_LABELS: Record<PlanSetting, string> = {
  review_period: 'Review period',
  time_sensitive_period: 'Time-sensitive period',
  lookback_period: 'Pre-existing lookback period',
  cfar_percent: 'CFAR reimbursement percentage',
  cfar_basis: 'CFAR basis (air or trip cost)',
  cfar_trip_cost_cap: 'CFAR trip cost cap',
  cfar_notice_period: 'CFAR cancellation notice period',
  interruption_limit_percent: 'Trip Interruption limit (% of trip cost)',
  pre_departure_start: 'Pre-departure cover starts',
  pre_departure_end: 'Pre-departure cover ends',
  post_departure_start: 'Post-departure cover starts',
  post_departure_end: 'Post-departure cover ends',
  extension_early_departure: 'Extension: early departure',
  extension_late_return: 'Extension: late return',
  extension_baggage: 'Extension: baggage',
  extension_hospitalisation: 'Extension: hospitalisation',
  annual_term: 'Annual term',
};

/** The underwriting arrangement a benefit's premium and documents follow (E05-F04-S01). */
export const ARRANGEMENTS = ['VSC', 'ABIC', 'VSC_CLIP'] as const;
export const ARRANGEMENT_LABELS: Record<(typeof ARRANGEMENTS)[number], string> = {
  VSC: 'Virginia Surety Company (VSC)',
  ABIC: 'American Bankers Insurance Company of Florida (ABIC)',
  VSC_CLIP: 'VSC, contractual liability insurance policy (CLIP)',
};

/**
 * When a benefit group's cover starts and ends (E05-F03-S01). Times are local date-times as the forms state
 * them. The departure instant is taken as the start of the departure date.
 */
export const TimingStartSchema = z.discriminatedUnion('kind', [
  /** 12:01 a.m. the day after the premium is received. */
  z.object({ kind: z.literal('day_after_premium_received') }),
  /** 12:01 a.m. on the purchase date. */
  z.object({ kind: z.literal('purchase_date') }),
  /** 12:01 a.m. on the departure date. */
  z.object({ kind: z.literal('departure') }),
]);
export const TimingEndSchema = z.discriminatedUnion('kind', [
  /** 11:59 p.m. on the return date. */
  z.object({ kind: z.literal('return_date') }),
  /** The start of the departure date. */
  z.object({ kind: z.literal('departure') }),
  /** A number of hours before the start of the departure date, as CFAR ends. */
  z.object({ kind: z.literal('hours_before_departure'), hours: z.number().int().min(1).max(720) }),
]);
export const TimingSchema = z.object({ start: TimingStartSchema, end: TimingEndSchema });
export type Timing = z.infer<typeof TimingSchema>;
export const TIMING_START_LABELS = {
  day_after_premium_received: '12:01 a.m. the day after premium is received',
  purchase_date: '12:01 a.m. on the purchase date',
  departure: '12:01 a.m. on the departure date',
} as const;
export const TIMING_END_LABELS = {
  return_date: '11:59 p.m. on the return date',
  departure: 'The start of the departure date',
  hours_before_departure: 'Hours before the start of the departure date',
} as const;

export const PlanValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.string()),
  z.object({ percent: z.number(), basis: z.string().optional() }),
  z.null(),
]);
export type PlanValue = z.infer<typeof PlanValueSchema>;

export const PlanDocumentSchema = z.object({
  benefits: z
    .array(
      z.object({
        code: CODE,
        packaging: z.enum(PACKAGING),
        /** The rate manual benefit that prices it (for example TCAN); null when not rated on its own. */
        ratingBenefit: z
          .string()
          .regex(/^[A-Z]{2,8}$/)
          .nullable()
          .default(null),
        /** The underwriting arrangement of this benefit; null until configured. */
        underwriter: z.enum(ARRANGEMENTS).nullable().default(null),
      }),
    )
    .default([]),
  upgrades: z.array(z.object({ code: CODE, packaging: z.enum(PACKAGING) })).default([]),
  coveredReasons: z
    .array(z.object({ code: CODE, levels: z.array(z.enum(COVERAGE_LEVELS)).min(1) }))
    .default([]),
  /** Values for form variables, keyed `schedule:key` or `policy:key`. */
  values: z.record(z.string().regex(/^(schedule|policy):[a-z][a-z0-9_]{1,63}$/), PlanValueSchema).default({}),
  settings: z
    .array(z.object({ setting: z.enum(PLAN_SETTINGS), variable: VariableRefSchema, value: PlanValueSchema }))
    .default([]),
  /** Base plans: what account plans may change, within these narrower bounds. */
  bounds: z
    .record(
      z.string(),
      z.object({
        min: z.number().optional(),
        max: z.number().optional(),
        options: z.array(z.string()).optional(),
      }),
    )
    .default({}),
  productType: z.string().max(40).nullable().default(null),
  /** Cover start and end per benefit group (or per benefit, which wins), keyed by group or benefit code. */
  timing: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), TimingSchema).default({}),
});
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

export const PlanSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(PLAN_KINDS),
  term: z.enum(['single_trip', 'annual']),
  parentPlanId: z.uuid().nullable(),
  state: z.string().nullable(),
  accountId: z.uuid().nullable(),
  scheduleEditionId: z.uuid(),
  policyEditionId: z.uuid().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  current: z.object({ id: z.uuid(), version: z.number().int(), status: z.string(), effectiveFrom: date }).nullable(),
  draft: z.object({ id: z.uuid(), version: z.number().int() }).nullable(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PLAN_VERSION_STATUSES = ['draft', 'approved', 'published', 'superseded', 'withdrawn'] as const;

export const PlanProblemSchema = z.object({ path: z.string(), message: z.string() });
export type PlanProblem = z.infer<typeof PlanProblemSchema>;

export const PlanVersionSchema = z.object({
  id: z.uuid(),
  planId: z.uuid(),
  version: z.number().int(),
  status: z.enum(PLAN_VERSION_STATUSES),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  catalogueId: z.uuid(),
  document: PlanDocumentSchema,
  problems: z.array(PlanProblemSchema),
  contributors: z.array(z.string()),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
  publishedBy: z.string().nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

export const CreatePlanRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('base'),
    code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, 'Capital letters, digits and -'),
    name: z.string().trim().min(2).max(200),
    term: z.enum(['single_trip', 'annual']),
    catalogueId: z.uuid(),
    effectiveFrom: date,
  }),
  z.object({
    kind: z.literal('state'),
    code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/),
    name: z.string().trim().min(2).max(200),
    parentPlanId: z.uuid(),
    state: z.string().regex(/^[A-Z]{2}$/),
    effectiveFrom: date,
  }),
  z.object({
    kind: z.literal('account'),
    code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/),
    name: z.string().trim().min(2).max(200),
    parentPlanId: z.uuid(),
    accountId: z.uuid(),
    effectiveFrom: date,
  }),
]);

export const PlanTestCaseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Travellers, trip and account; the plan supplies benefits, package types, perils and settings. */
  input: QuoteRatingRequestSchema.pick({ rateDate: true, travellers: true, trip: true, account: true }),
  expected: z.object({
    policyTotal: DecimalString.optional(),
    perBenefit: z.record(z.string(), DecimalString).optional(),
  }),
});
export type PlanTestCase = z.infer<typeof PlanTestCaseSchema>;

export const PlanTestRunSchema = z.object({
  versionId: z.uuid(),
  ranAt: z.iso.datetime({ offset: true }),
  total: z.number().int(),
  passed: z.number().int(),
  results: z.array(
    z.object({
      caseId: z.uuid(),
      name: z.string(),
      passed: z.boolean(),
      message: z.string(),
      actual: z.object({ policyTotal: z.string(), perBenefit: z.record(z.string(), z.string()) }).nullable(),
    }),
  ),
});
export type PlanTestRun = z.infer<typeof PlanTestRunSchema>;

export const PlanDiffSchema = z.object({
  from: z.object({ id: z.uuid(), version: z.number().int() }),
  to: z.object({ id: z.uuid(), version: z.number().int() }),
  changes: z.array(
    z.object({
      area: z.enum(['benefit', 'upgrade', 'covered_reason', 'value', 'setting', 'bound', 'timing', 'link', 'dates']),
      item: z.string(),
      change: z.enum(['added', 'removed', 'changed']),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
});
export type PlanDiff = z.infer<typeof PlanDiffSchema>;

export const PublishCheckSchema = z.object({
  check: z.enum(['approved', 'catalogue', 'forms_filed', 'manuals', 'values', 'tests']),
  passed: z.boolean(),
  detail: z.string(),
});
