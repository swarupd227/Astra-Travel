import { z } from 'zod';

/** Contracts for card-linked cover (specification M18, epic E21). */

const date = z.iso.date();
const US_STATE = /^[A-Z]{2}$/;

export const PROGRAMME_STATUSES = ['draft', 'live', 'suspended', 'closed'] as const;
export const PROGRAMME_STATUS_TRANSITIONS: Record<
  (typeof PROGRAMME_STATUSES)[number],
  readonly string[]
> = {
  draft: ['closed'], // going live needs a passed test feed: see the go-live endpoint
  live: ['suspended', 'closed'],
  suspended: ['live', 'closed'],
  closed: [],
};

export const PaymentConditionSchema = z.discriminatedUnion('rule', [
  z.object({ rule: z.literal('none') }),
  z.object({ rule: z.literal('full') }),
  z.object({ rule: z.literal('partial'), minimumPercent: z.number().min(0).max(100) }),
]);
export type PaymentCondition = z.infer<typeof PaymentConditionSchema>;

export const ELIGIBILITY_RULES = ['purchase_date', 'purchase_and_loss_date'] as const;

export const MasterPolicySchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  policyNumber: z.string(),
  underwriter: z.string(),
  states: z.array(z.string()),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  status: z.enum(['active', 'cancelled']),
  createdAt: z.iso.datetime({ offset: true }),
});
export type MasterPolicy = z.infer<typeof MasterPolicySchema>;

export const UNDERWRITERS = ['VSC', 'ABIC'] as const;

export const CreateMasterPolicyRequestSchema = z
  .object({
    accountId: z.uuid(),
    policyNumber: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, 'Use 3 to 40 capital letters, digits or -'),
    underwriter: z.enum(UNDERWRITERS),
    states: z.array(z.string().regex(US_STATE, 'Two-letter US state code')).min(1).max(56),
    effectiveFrom: date,
    effectiveTo: date.nullable().optional(),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo > v.effectiveFrom, {
    message: 'Must be after the effective date',
    path: ['effectiveTo'],
  });

export const CardProgrammeSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  accountName: z.string(),
  code: z.string(),
  name: z.string(),
  cardProduct: z.string(),
  masterPolicyId: z.uuid(),
  masterPolicyNumber: z.string(),
  states: z.array(z.string()),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  paymentCondition: PaymentConditionSchema,
  eligibilityRule: z.enum(ELIGIBILITY_RULES),
  maxRejectPercent: z.number(),
  status: z.enum(PROGRAMME_STATUSES),
  lastAppliedSequence: z.number().int(),
  eligibleAccounts: z.number().int(),
  certificates: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type CardProgramme = z.infer<typeof CardProgrammeSchema>;

export const CreateCardProgrammeRequestSchema = z
  .object({
    masterPolicyId: z.uuid(),
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/, 'Use 3 to 32 capital letters, digits or -'),
    name: z.string().trim().min(2).max(200),
    cardProduct: z.string().trim().min(1).max(100),
    states: z.array(z.string().regex(US_STATE, 'Two-letter US state code')).min(1).max(56),
    effectiveFrom: date,
    effectiveTo: date.nullable().optional(),
    paymentCondition: PaymentConditionSchema,
    eligibilityRule: z.enum(ELIGIBILITY_RULES),
    maxRejectPercent: z.number().min(0).max(50).default(1),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo > v.effectiveFrom, {
    message: 'Must be after the effective date',
    path: ['effectiveTo'],
  });

export const ChangeProgrammeStatusRequestSchema = z.object({
  status: z.enum(['suspended', 'live', 'closed']),
  reason: z.string().trim().min(5).max(500),
});

export const GoLiveRequestSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});

export const RejectFeedRequestSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});

export const EligibilityCheckRequestSchema = z.object({
  accountRef: z.string().trim().min(1).max(64),
  date,
});

export const FEED_KINDS = ['FULL', 'CHANGE'] as const;
export const FEED_MODES = ['live', 'test'] as const;
export const FEED_STATUSES = [
  'received',
  'waiting',
  'applied',
  'held',
  'rejected',
  'passed',
  'failed',
] as const;

export const FeedStatsSchema = z.object({
  detailRecords: z.number().int(),
  rejectedRecords: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
  unchanged: z.number().int(),
  certificatesIssued: z.number().int(),
});
export type FeedStats = z.infer<typeof FeedStatsSchema>;

export const EligibilityFeedSchema = z.object({
  id: z.uuid(),
  programmeId: z.uuid(),
  mode: z.enum(FEED_MODES),
  sequence: z.number().int().nullable(),
  kind: z.enum(FEED_KINDS).nullable(),
  asOfDate: date.nullable(),
  fileName: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(FEED_STATUSES),
  statusReason: z.string().nullable(),
  stats: FeedStatsSchema.nullable(),
  receivedAt: z.iso.datetime({ offset: true }),
  receivedBy: z.string(),
  processedAt: z.iso.datetime({ offset: true }).nullable(),
  durationMs: z.number().int().nullable(),
});
export type EligibilityFeed = z.infer<typeof EligibilityFeedSchema>;

export const FeedRejectionSchema = z.object({
  lineNumber: z.number().int(),
  accountRef: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});
export type FeedRejection = z.infer<typeof FeedRejectionSchema>;

export const EligibilityAnswerSchema = z.object({
  date,
  eligible: z.boolean(),
  productCode: z.string().nullable(),
  period: z.object({ from: date, to: date.nullable() }).nullable(),
  /** The feed whose records established the period that covers the date. */
  supportedByFeed: z
    .object({ id: z.uuid(), sequence: z.number().int().nullable(), asOfDate: date.nullable() })
    .nullable(),
  programmeInForce: z.boolean(),
});
export type EligibilityAnswer = z.infer<typeof EligibilityAnswerSchema>;

export const CoverVerificationRequestSchema = z.object({
  type: z.literal('certificate'),
  programmeCode: z.string().max(32),
  accountRef: z.string().min(1).max(64),
  purchaseDate: date,
  lossDate: date,
  payment: z
    .object({
      tripCost: z.number().positive(),
      amountPaidWithAccount: z.number().min(0),
    })
    .optional(),
});

export const CoverVerificationSchema = z.object({
  covered: z.boolean(),
  reasons: z.array(z.string()),
  certificateNumber: z.string().nullable(),
  programme: z.object({ id: z.uuid(), code: z.string(), name: z.string(), status: z.string() }),
  masterPolicy: z.object({ policyNumber: z.string(), underwriter: z.string() }),
  states: z.array(z.string()),
  onPurchaseDate: EligibilityAnswerSchema,
  onLossDate: EligibilityAnswerSchema,
  paymentCondition: z.object({
    rule: PaymentConditionSchema,
    met: z.boolean().nullable(),
    explanation: z.string(),
  }),
  checkedAt: z.iso.datetime({ offset: true }),
});
export type CoverVerification = z.infer<typeof CoverVerificationSchema>;
