import { z } from 'zod';

/** Filing register (E10-F01-S01) and the configuration check against filings (E10-F01-S02). */

const date = z.iso.date();

export const FILING_ITEM_TYPES = ['form_edition', 'rate_manual', 'rule_set'] as const;
export type FilingItemType = (typeof FILING_ITEM_TYPES)[number];
export const FILING_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'disapproved',
  'withdrawn',
] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];
export const INSURERS = ['VSC', 'ABIC'] as const;

/** Allowed status changes. An approved filing is withdrawn (or replaced by a new filing), never edited. */
export const FILING_TRANSITIONS: Record<FilingStatus, readonly FilingStatus[]> = {
  draft: ['submitted', 'withdrawn'],
  submitted: ['approved', 'disapproved', 'withdrawn'],
  approved: ['withdrawn'],
  disapproved: [],
  withdrawn: [],
};

export const FilingSchema = z.object({
  id: z.uuid(),
  state: z.string(),
  insurer: z.enum(INSURERS),
  itemType: z.enum(FILING_ITEM_TYPES),
  itemId: z.uuid().nullable(),
  itemReference: z.string(),
  serffTracking: z.string().nullable(),
  status: z.enum(FILING_STATUSES),
  submittedOn: date.nullable(),
  decidedOn: date.nullable(),
  effectiveFrom: date.nullable(),
  effectiveTo: date.nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Filing = z.infer<typeof FilingSchema>;

export const FilingEventSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  actor: z.string(),
  fromStatus: z.string().nullable(),
  toStatus: z.string(),
  reason: z.string().nullable(),
});

const SERFF = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{3,39}$/, 'Letters, digits and -, for example AMSU-134567890');

export const CreateFilingRequestSchema = z
  .object({
    states: z
      .array(z.string().regex(/^[A-Z]{2}$/, 'Two-letter state code'))
      .min(1)
      .max(56),
    insurer: z.enum(INSURERS),
    itemType: z.enum(FILING_ITEM_TYPES),
    itemId: z.uuid().optional(),
    itemReference: z.string().trim().min(2).max(200).optional(),
    serffTracking: SERFF.optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.itemType !== 'form_edition' || v.itemId, {
    message: 'Choose the form edition',
    path: ['itemId'],
  })
  .refine((v) => v.itemType === 'form_edition' || v.itemReference, {
    message: 'Give the filed manual or rule set reference',
    path: ['itemReference'],
  });

export const ChangeFilingStatusRequestSchema = z
  .object({
    status: z.enum(['submitted', 'approved', 'disapproved', 'withdrawn']),
    on: date,
    effectiveFrom: date.optional(),
    effectiveTo: date.nullable().optional(),
    serffTracking: SERFF.optional(),
    reason: z.string().trim().min(5).max(500),
  })
  .refine((v) => v.status !== 'approved' || v.effectiveFrom, {
    message: 'An approval needs its effective date',
    path: ['effectiveFrom'],
  })
  .refine((v) => !v.effectiveTo || !v.effectiveFrom || v.effectiveTo > v.effectiveFrom, {
    message: 'Must be after the effective date',
    path: ['effectiveTo'],
  });

export const ApprovalAnswerSchema = z.object({
  approved: z.boolean(),
  reason: z.string(),
  filing: FilingSchema.nullable(),
});
export type ApprovalAnswer = z.infer<typeof ApprovalAnswerSchema>;
