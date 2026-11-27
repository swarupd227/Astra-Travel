import { z } from 'zod';
import { CfarEligibilitySchema } from './rating';

/** Underwriting and eligibility rules (E03). Design: docs/adr/0008. */

const date = z.iso.date();
const CODE = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'An amount such as 4200 or 4200.00');

// ---------------- Rule conditions (data, never code) ----------------

/** Fields a rule can test. Traveller fields are tested for each traveller; a rule fires if any traveller meets it. */
export const RULE_FIELDS = [
  'traveller_age',
  'cost_per_traveller',
  'trip_days',
  'total_trip_cost',
  'traveller_count',
  'destination_country',
  'destination_region',
  'business_segment',
  'days_before_departure',
  'insured_percent',
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_FIELD_LABELS: Record<RuleField, string> = {
  traveller_age: 'Traveller age',
  cost_per_traveller: 'Trip cost per traveller',
  trip_days: 'Trip length (days)',
  total_trip_cost: 'Total trip cost',
  traveller_count: 'Number of travellers',
  destination_country: 'Destination country',
  destination_region: 'Destination region',
  business_segment: 'Business segment',
  days_before_departure: 'Days before departure',
  insured_percent: 'Percentage of trip costs insured',
};

export const RULE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'] as const;
export const RULE_OP_LABELS: Record<(typeof RULE_OPS)[number], string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  not_in: 'is none of',
};

const Scalar = z.union([z.number(), z.string()]);

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | {
      field: RuleField;
      op: (typeof RULE_OPS)[number];
      value: z.infer<typeof Scalar> | z.infer<typeof Scalar>[];
    };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1).max(20) }),
    z.object({ any: z.array(ConditionSchema).min(1).max(20) }),
    z.object({ not: ConditionSchema }),
    z.object({
      field: z.enum(RULE_FIELDS),
      op: z.enum(RULE_OPS),
      value: z.union([Scalar, z.array(Scalar).min(1).max(100)]),
    }),
  ]),
);

export const LIMIT_KINDS = [
  'min_age',
  'max_age',
  'min_trip_days',
  'max_trip_days',
  'min_trip_cost',
  'max_trip_cost',
] as const;
export const LIMIT_LABELS: Record<(typeof LIMIT_KINDS)[number], string> = {
  min_age: 'Minimum age',
  max_age: 'Maximum age',
  min_trip_days: 'Minimum trip length (days)',
  max_trip_days: 'Maximum trip length (days)',
  min_trip_cost: 'Minimum trip cost per traveller',
  max_trip_cost: 'Maximum trip cost per traveller',
};

export const RuleSetDocumentSchema = z.object({
  /** Plan limits (E03-F01-S02): a quote outside a limit is ineligible, with the reason. */
  limits: z
    .array(z.object({ code: CODE, kind: z.enum(LIMIT_KINDS), value: z.number().nonnegative() }))
    .default([]),
  referralRules: z
    .array(
      z.object({
        code: CODE,
        name: z.string().trim().min(2).max(200),
        when: ConditionSchema,
        /** A decline is only ever recommended; a person decides. */
        action: z.enum(['refer', 'recommend_decline']),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .default([]),
  /** Benefits available only when bought within the time-sensitive period (E03-F03). */
  timeBasedBenefits: z.array(z.object({ benefit: CODE })).default([]),
  ableToTravelRequired: z.boolean().default(true),
  prohibitedDestinations: z.boolean().default(true),
  sanctions: z
    .object({
      enabled: z.boolean().default(true),
      matchThreshold: z.number().min(0.5).max(1).default(0.9),
    })
    .default({ enabled: true, matchThreshold: 0.9 }),
  duplicates: z
    .object({
      enabled: z.boolean().default(true),
      allowSingleAndAnnual: z.boolean().default(false),
    })
    .default({ enabled: true, allowSingleAndAnnual: false }),
});
export type RuleSetDocument = z.infer<typeof RuleSetDocumentSchema>;

export const RuleProblemSchema = z.object({ path: z.string(), message: z.string() });
export type RuleProblem = z.infer<typeof RuleProblemSchema>;

export const RULE_SET_STATUSES = ['draft', 'approved', 'published', 'superseded'] as const;

export const RuleSetSchema = z.object({
  id: z.uuid(),
  planId: z.uuid(),
  version: z.number().int(),
  status: z.enum(RULE_SET_STATUSES),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  document: RuleSetDocumentSchema,
  problems: z.array(RuleProblemSchema),
  contributors: z.array(z.string()),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
  publishedBy: z.string().nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RuleSet = z.infer<typeof RuleSetSchema>;

// ---------------- Evaluation ----------------

export const TravellerInputSchema = z.object({
  id: z.string().min(1).max(40),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  dateOfBirth: date.optional(),
  age: z.number().int().min(0).max(120).optional(),
  /** Per-traveller trip cost when known. */
  costPerTraveller: money.optional(),
});

export const STAGES = ['quote', 'bind', 'change', 'refund'] as const;

export const EvaluationInputSchema = z
  .object({
    stage: z.enum(STAGES),
    /** Date the decision is made on; defaults to the purchase date. */
    asOf: date.optional(),
    travellers: z.array(TravellerInputSchema).min(1).max(20),
    trip: z.object({
      purchaseDate: date,
      /** Date of the initial trip deposit, when the trip was paid for in stages. */
      initialDepositDate: date.optional(),
      /** Date the premium is received; defaults to the purchase date. */
      premiumReceivedDate: date.optional(),
      departureDate: date,
      returnDate: date,
      destinations: z
        .array(
          z.object({
            country: z
              .string()
              .regex(/^[A-Z]{2}$/)
              .optional(),
            region: z.string().max(100).optional(),
          }),
        )
        .max(30)
        .default([]),
      totalTripCost: money.optional(),
    }),
    /** Percentage of the relevant trip costs the plan insures (100 means all of them). */
    insuredPercent: z.number().min(0).max(100),
    ableToTravel: z.boolean().nullable(),
    businessSegment: z.string().max(100).optional(),
    term: z.enum(['single_trip', 'annual']).default('single_trip'),
    /** Benefits the traveller wants (catalogue codes), for time-based availability. */
    benefits: z.array(CODE).max(60).default([]),
    cfarRequested: z.boolean().default(false),
    /** Policy being changed, ignored by the duplicate check. */
    policyRef: z.string().max(100).optional(),
  })
  .refine((v) => v.travellers.every((t) => t.age !== undefined || t.dateOfBirth !== undefined), {
    message: 'Give each traveller an age or a date of birth',
    path: ['travellers'],
  });
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;

export const CheckSchema = z.object({
  /** Which rule family made the check. */
  area: z.enum([
    'declaration',
    'limit',
    'prohibited_destination',
    'sanctions',
    'duplicate',
    'referral_rule',
    'waiver',
    'cfar',
    'time_based',
  ]),
  code: z.string(),
  passed: z.boolean(),
  detail: z.string(),
  travellerId: z.string().nullable().default(null),
});
export type Check = z.infer<typeof CheckSchema>;

export const EvaluationResultSchema = z.object({
  outcome: z.enum(['eligible', 'ineligible', 'referred', 'held']),
  stage: z.enum(STAGES),
  planVersionId: z.uuid(),
  ruleSet: z.object({ id: z.uuid(), version: z.number().int() }),
  preview: z.boolean(),
  checks: z.array(CheckSchema),
  /** Plain reasons the case is ineligible. */
  reasons: z.array(z.string()),
  referrals: z.array(
    z.object({
      rule: z.string(),
      reason: z.string(),
      recommendation: z.enum(['refer', 'recommend_decline']),
    }),
  ),
  waiver: z.object({
    applies: z.boolean(),
    conditions: z.array(CheckSchema),
    timeSensitiveDays: z.number().nullable(),
    lookbackDays: z.number().nullable(),
  }),
  cfar: CfarEligibilitySchema.extend({
    offered: z.boolean(),
    conditions: z.array(CheckSchema),
    noticePeriod: z.number().nullable(),
  }),
  benefitAvailability: z.array(
    z.object({ benefit: z.string(), available: z.boolean(), reason: z.string() }),
  ),
  screening: z.object({
    listVersion: z.string().nullable(),
    screened: z.number().int(),
    possibleMatches: z.array(
      z.object({
        travellerId: z.string(),
        uid: z.string(),
        name: z.string(),
        program: z.string().nullable(),
        score: z.number(),
        reason: z.string(),
      }),
    ),
  }),
  duplicates: z.object({
    registerRows: z.number().int(),
    matches: z.array(
      z.object({
        travellerId: z.string(),
        policyRef: z.string(),
        tripStart: date,
        tripEnd: date,
        term: z.string(),
      }),
    ),
  }),
  referralId: z.uuid().nullable(),
  summary: z.string(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

// ---------------- Rule set tests ----------------

export const RuleTestCaseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  input: EvaluationInputSchema,
  expected: z.object({
    outcome: z.enum(['eligible', 'ineligible', 'referred', 'held']),
    /** Referral rule codes expected to fire. */
    referralRules: z.array(CODE).optional(),
    waiver: z.boolean().optional(),
    cfarOffered: z.boolean().optional(),
    /** Text each expected reason must contain. */
    reasonsInclude: z.array(z.string().min(2).max(200)).optional(),
  }),
  /** For duplicate checks: covers to treat as existing instead of the register. */
  existingCovers: z
    .array(
      z.object({
        firstName: z.string(),
        lastName: z.string(),
        dateOfBirth: date.optional(),
        policyRef: z.string(),
        tripStart: date,
        tripEnd: date,
        term: z.enum(['single_trip', 'annual']),
      }),
    )
    .optional(),
});
export type RuleTestCase = z.infer<typeof RuleTestCaseSchema>;

export const RuleTestRunSchema = z.object({
  ruleSetId: z.uuid(),
  ranAt: z.iso.datetime({ offset: true }),
  total: z.number().int(),
  passed: z.number().int(),
  results: z.array(
    z.object({ caseId: z.uuid(), name: z.string(), passed: z.boolean(), message: z.string() }),
  ),
});
export type RuleTestRun = z.infer<typeof RuleTestRunSchema>;

// ---------------- Sanctions lists ----------------

export const SanctionsListSchema = z.object({
  id: z.uuid(),
  source: z.string(),
  publishedOn: date.nullable(),
  status: z.enum(['draft', 'approved', 'rejected', 'superseded']),
  entries: z.number().int(),
  aliases: z.number().int(),
  sha256: z.string(),
  loadedBy: z.string(),
  loadedAt: z.iso.datetime({ offset: true }),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type SanctionsList = z.infer<typeof SanctionsListSchema>;

// ---------------- Referrals ----------------

export const REFERRAL_KINDS = ['underwriting', 'sanctions'] as const;
export const ReferralSchema = z.object({
  id: z.uuid(),
  caseRef: z.string(),
  kind: z.enum(REFERRAL_KINDS),
  stage: z.enum(STAGES),
  status: z.enum(['open', 'approved', 'declined']),
  recommendation: z.enum(['refer', 'recommend_decline']),
  ruleSetId: z.uuid(),
  planVersionId: z.uuid(),
  summary: z.string(),
  evaluation: EvaluationResultSchema,
  createdAt: z.iso.datetime({ offset: true }),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  decisionReason: z.string().nullable(),
});
export type Referral = z.infer<typeof ReferralSchema>;

// ---------------- Events ----------------
// defined in events.ts

export const DeclarationRequestSchema = z.object({
  planVersionId: z.uuid(),
  /** The quote, cart or traveller the confirmation belongs to. */
  subjectRef: z.string().trim().min(1).max(100),
  confirmed: z.boolean(),
  noticeText: z.string().trim().min(10).max(5000),
});
export const DeclarationSchema = z.object({
  id: z.uuid(),
  planVersionId: z.uuid(),
  subjectRef: z.string(),
  confirmed: z.boolean(),
  noticeText: z.string(),
  formEditionId: z.uuid(),
  formReference: z.string(),
  textSha256: z.string(),
  recordedBy: z.string(),
  recordedAt: z.iso.datetime({ offset: true }),
});
export type Declaration = z.infer<typeof DeclarationSchema>;
