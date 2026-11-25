import { z } from 'zod';
import { PolicySchema } from './policies';

/** Policy servicing: cancellations, changes and corrections after bind (E06). Design: docs/adr/0012. */

const date = z.iso.date();
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'An amount such as 4200 or 4200.00');
const signed = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'An amount such as 12.50 or -12.50');
const CODE = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const reason = z.string().trim().min(3, 'Give the reason').max(500);

export const SERVICING_TYPES = ['cancel', 'change_dates', 'change_cost', 'add_traveller', 'remove_traveller', 'change_destinations', 'add_benefits', 'correct'] as const;
export type ServicingType = (typeof SERVICING_TYPES)[number];

export const SERVICING_LABELS: Record<ServicingType, string> = {
  cancel: 'Cancel the policy',
  change_dates: 'Change the trip dates',
  change_cost: 'Change the insured trip cost',
  add_traveller: 'Add a traveller',
  remove_traveller: 'Remove a traveller',
  change_destinations: 'Change the destinations',
  add_benefits: 'Add a benefit or upgrade',
  correct: 'Correct a data error',
};

export const ServicingRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cancel'), reason, /** The requester confirms the traveller has had no loss that would lead to a claim. */ noLoss: z.boolean() }),
  z.object({ type: z.literal('change_dates'), reason, departureDate: date, returnDate: date }),
  z.object({ type: z.literal('change_cost'), reason, costs: z.array(z.object({ travellerId: z.string().min(1).max(20), costPerTraveller: money })).min(1).max(20), insuredPercent: z.number().min(0).max(100).optional() }),
  z.object({
    type: z.literal('add_traveller'),
    reason,
    traveller: z
      .object({ firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100), dateOfBirth: date.optional(), age: z.number().int().min(0).max(120).optional(), costPerTraveller: money })
      .refine((t) => t.age !== undefined || t.dateOfBirth !== undefined, { message: 'Give an age or a date of birth', path: ['age'] }),
  }),
  z.object({ type: z.literal('remove_traveller'), reason, travellerId: z.string().min(1).max(20), noLoss: z.boolean() }),
  z.object({ type: z.literal('change_destinations'), reason, destinations: z.array(z.object({ country: z.string().regex(/^[A-Z]{2}$/).optional(), region: z.string().max(100).optional(), days: z.number().int().min(1).max(400).optional() })).min(1).max(30) }),
  z.object({ type: z.literal('add_benefits'), reason, benefits: z.array(CODE).min(1).max(20) }),
  z.object({
    type: z.literal('correct'),
    reason,
    travellers: z.array(z.object({ travellerId: z.string().min(1).max(20), firstName: z.string().trim().min(1).max(100).optional(), lastName: z.string().trim().min(1).max(100).optional(), dateOfBirth: date.optional() })).max(20).default([]),
    purchaser: z.object({ name: z.string().trim().min(2).max(200).optional(), email: z.email().optional() }).optional(),
    supplier: z.string().trim().max(200).optional(),
  }),
]);
export type ServicingRequest = z.infer<typeof ServicingRequestSchema>;

export const ServicingPreviewSchema = z.object({
  type: z.enum(SERVICING_TYPES),
  /** False when the change cannot be made; `problems` says why. */
  allowed: z.boolean(),
  problems: z.array(z.string()),
  summary: z.string(),
  changes: z.array(z.object({ what: z.string(), before: z.string(), after: z.string() })),
  premium: z.object({ before: money, after: money, delta: signed }).nullable(),
  /** What is charged or refunded, and what the plan's rule keeps. */
  money: z.object({ charge: money, refund: money, retained: money, explanation: z.string() }),
  reviewPeriod: z.object({ inReview: z.boolean(), endsAt: z.string().nullable() }),
  /** The amount the person confirms: the refund for a cancellation, the premium change otherwise. */
  confirmAmount: signed,
});
export type ServicingPreview = z.infer<typeof ServicingPreviewSchema>;

export const ServicingApplyRequestSchema = z.object({
  request: ServicingRequestSchema,
  /** The `confirmAmount` the person was shown. The change is refused if the price has moved. */
  confirmAmount: signed,
  /** For the servicing agent: the requester's own words confirming the change and its price, which must be in the request it is working on. */
  agentConfirmation: z.string().trim().min(2).max(500).optional(),
});
export type ServicingApplyRequest = z.infer<typeof ServicingApplyRequestSchema>;

export const ServicingResultSchema = z.object({
  type: z.enum(SERVICING_TYPES),
  policy: PolicySchema,
  money: z.object({ charge: money, refund: money, retained: money, explanation: z.string() }),
  /** The change or cancellation notice issued for the transaction, when one could be produced. */
  noticeDocumentId: z.uuid().nullable(),
});
export type ServicingResult = z.infer<typeof ServicingResultSchema>;

export const AgentSampleItemSchema = z.object({
  policyId: z.uuid(),
  policyNumber: z.string(),
  seq: z.number().int(),
  occurredAt: z.iso.datetime({ offset: true }),
  actor: z.string(),
  transaction: z.string(),
  reason: z.string().nullable(),
  summary: z.string().nullable(),
  amount: z.string().nullable(),
});
