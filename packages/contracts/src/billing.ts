import { z } from 'zod';

/** Premium records, commission, tax and the billing interface (E08, E14-F03-S01). Design: docs/adr/0013. */

const signed = z.string().regex(/^-?\d+\.\d{2}$/, 'An amount such as 12.50 or -12.50');
const money = z.string().regex(/^\d+\.\d{2}$/);
const percent = z.number().min(0).max(100);

export const RECORD_TYPES = ['bind', 'change', 'cancellation', 'programme'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const RECORD_STATUSES = ['held', 'ready', 'batched', 'sent', 'confirmed', 'rejected'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export const BATCH_STATUSES = ['ready', 'sent', 'confirmed', 'mismatch', 'unconfirmed', 'rejected'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

// ---------------- Commission rules (E08-F02-S01) ----------------

export const CommissionRuleDocumentSchema = z.discriminatedUnion('kind', [
  /** The account is paid no commission. Explicit, so that "not configured" is never mistaken for it. */
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('flat'), percent }),
  /** Marginal percents on the account's premium so far in the calendar month. `upTo` is dollars; null is the last tier. */
  z.object({
    kind: z.literal('tiered'),
    tiers: z
      .array(z.object({ upTo: z.number().positive().nullable(), percent }))
      .min(1)
      .max(20)
      .refine((t) => t.every((x, i) => (i < t.length - 1 ? x.upTo !== null && (i === 0 || x.upTo > t[i - 1]!.upTo!) : x.upTo === null)), { message: 'Tiers rise, and the last has no upper limit' }),
  }),
  /** One percent for all of a policy's premium, chosen by how many policies the account has sold this month. */
  z.object({
    kind: z.literal('volume'),
    bands: z
      .array(z.object({ minPolicies: z.number().int().min(0), percent }))
      .min(1)
      .max(20)
      .refine((b) => b.every((x, i) => i === 0 || x.minPolicies > b[i - 1]!.minPolicies) && b[0]!.minPolicies === 0, { message: 'Bands start at 0 policies and rise' }),
  }),
]);
export type CommissionRuleDocument = z.infer<typeof CommissionRuleDocumentSchema>;

export const CreateCommissionRuleSchema = z.object({ accountId: z.uuid(), effectiveFrom: z.iso.date(), document: CommissionRuleDocumentSchema });

export const CommissionRuleSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  version: z.number().int(),
  effectiveFrom: z.iso.date(),
  status: z.enum(['draft', 'approved', 'superseded']),
  document: CommissionRuleDocumentSchema,
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CommissionRule = z.infer<typeof CommissionRuleSchema>;

// ---------------- Programme premium (E08-F04-S02) ----------------

export const CreateProgrammeRuleSchema = z.object({
  programmeId: z.uuid(),
  effectiveFrom: z.iso.date(),
  /** The programme's basis: per eligible account per month. The rate is the agreed amount in dollars. */
  basis: z.literal('per_account_per_month').default('per_account_per_month'),
  rate: z.string().regex(/^\d+(\.\d{1,4})?$/),
});
export const ProgrammeRuleSchema = z.object({
  id: z.uuid(),
  programmeId: z.uuid(),
  accountId: z.uuid(),
  version: z.number().int(),
  effectiveFrom: z.iso.date(),
  basis: z.literal('per_account_per_month'),
  rate: z.string(),
  status: z.enum(['draft', 'approved', 'superseded']),
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
});
export const ProgrammePremiumRequestSchema = z.object({ programmeId: z.uuid(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

// ---------------- Premium records (E08-F01) ----------------

export const AllocationLineSchema = z.object({
  entity: z.enum(['VSC', 'ABIC', 'UNASSIGNED']),
  /** VSC_CLIP is VSC's entity with the CLIP arrangement shown. */
  arrangement: z.enum(['VSC', 'ABIC', 'VSC_CLIP']).nullable(),
  premium: signed,
  taxRatePercent: z.number().nullable(),
  tax: signed.nullable(),
});

export const PremiumRecordSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  type: z.enum(RECORD_TYPES),
  status: z.enum(RECORD_STATUSES),
  accountId: z.uuid(),
  policyId: z.uuid().nullable(),
  policyNumber: z.string().nullable(),
  programmeId: z.uuid().nullable(),
  policyEventSeq: z.number().int().nullable(),
  /** The month a programme record covers. */
  period: z.string().nullable(),
  state: z.string().nullable(),
  /** Why the record is held, in words, until it is recalculated. */
  issues: z.array(z.string()),
  /** Signed: a charge is positive, a refund negative. */
  premium: signed,
  charge: money,
  refund: money,
  /** Premium the plan's rule kept although the policy's premium fell. */
  retained: money,
  perBenefit: z.array(z.object({ code: z.string(), premium: signed })),
  perTraveller: z.array(z.object({ travellerId: z.string(), premium: signed })),
  allocation: z.array(AllocationLineSchema),
  commission: z.object({ amount: signed, ratePercent: z.string(), rule: z.string() }).nullable(),
  tax: signed.nullable(),
  /** The account's billing basis and its calculation, as the quote stored them. */
  basis: z.record(z.string(), z.unknown()).nullable(),
  worksheetIds: z.array(z.uuid()),
  occurredAt: z.iso.datetime({ offset: true }),
  batchId: z.uuid().nullable(),
  billingReference: z.string().nullable(),
  billingReason: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type PremiumRecord = z.infer<typeof PremiumRecordSchema>;

export const PremiumRecordSummarySchema = PremiumRecordSchema.pick({ id: true, number: true, type: true, status: true, accountId: true, policyId: true, policyNumber: true, programmeId: true, period: true, state: true, issues: true, premium: true, refund: true, commission: true, tax: true, occurredAt: true, batchId: true, billingReference: true });

// ---------------- Batches and confirmations (E08-F03, E08-F04-S01) ----------------

export const ControlTotalsSchema = z.object({
  count: z.number().int(),
  premium: signed,
  charges: money,
  refunds: money,
  commission: signed,
  tax: signed,
});
export type ControlTotals = z.infer<typeof ControlTotalsSchema>;

export const BatchSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  status: z.enum(BATCH_STATUSES),
  totals: ControlTotalsSchema,
  sha256: z.string(),
  sizeBytes: z.number().int(),
  channel: z.enum(['file', 'http']).nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  confirmedAt: z.iso.datetime({ offset: true }).nullable(),
  nextAttemptAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Batch = z.infer<typeof BatchSchema>;

export const CreateBatchSchema = z.object({ limit: z.number().int().min(1).max(200_000).default(50_000) });

/** What the billing system answers for a batch: what it received, and what it did with each record. */
export const ConfirmationSchema = z.object({
  batchId: z.uuid(),
  received: z.object({ count: z.number().int().min(0), premium: signed, commission: signed, tax: signed }),
  records: z
    .array(z.object({ recordId: z.uuid(), status: z.enum(['accepted', 'rejected']), reference: z.string().trim().max(100).optional(), reason: z.string().trim().max(500).optional() }))
    .max(200_000),
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;
