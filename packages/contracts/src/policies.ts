import { z } from 'zod';
import { BillingBasisSchema } from './rating';
import { ARRANGEMENTS } from './plans';
import { EvaluationResultSchema } from './underwriting';

/** Quotes, bind and the policy record (E04, E05). Design: docs/adr/0010. */

const date = z.iso.date();
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'An amount such as 4200 or 4200.00');
const CODE = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
/** A local date-time as the forms state times (no time zone), for example 2026-11-22T00:01. */
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

// ---------------- Quote ----------------

export const QuoteTravellerSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    dateOfBirth: date.optional(),
    age: z.number().int().min(0).max(120).optional(),
    /** The trip cost this traveller insures. */
    costPerTraveller: money,
  })
  .refine((t) => t.age !== undefined || t.dateOfBirth !== undefined, {
    message: 'Give an age or a date of birth',
    path: ['age'],
  });

export const QuoteTripSchema = z
  .object({
    purchaseDate: date.optional(),
    initialDepositDate: date.optional(),
    finalPaymentDate: date.optional(),
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
          days: z.number().int().min(1).max(400).optional(),
        }),
      )
      .max(30)
      .default([]),
    supplier: z.string().trim().max(200).optional(),
    /** The supplier's cancellation penalty schedule: from this many days before departure, this share is lost. */
    penaltySchedule: z
      .array(
        z.object({
          daysBeforeDeparture: z.number().int().min(0).max(1000),
          percent: z.number().min(0).max(100),
        }),
      )
      .max(20)
      .optional(),
    penaltyDays: z.number().int().min(0).max(1000).optional(),
  })
  .refine((t) => t.returnDate >= t.departureDate, {
    message: 'The return date is before the departure date',
    path: ['returnDate'],
  });

export const CreateQuoteRequestSchema = z.object({
  accountId: z.uuid(),
  /** The code of the state or account plan to quote. */
  planCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/),
  /** The state the cover is sold in. */
  state: z.string().regex(/^[A-Z]{2}$/),
  travellers: z.array(QuoteTravellerSchema).min(1).max(20),
  trip: QuoteTripSchema,
  /** Percentage of the relevant trip costs the cover insures. */
  insuredPercent: z.number().min(0).max(100).default(100),
  businessSegment: z.string().trim().max(100).optional(),
  /** Optional benefits to include, by plan benefit code. */
  selection: z.array(CODE).max(60).default([]),
  billingBasis: BillingBasisSchema.optional(),
});
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequestSchema>;

export const UpdateSelectionRequestSchema = z.object({ selection: z.array(CODE).max(60) });

export const QuoteBenefitSchema = z.object({
  code: z.string(),
  name: z.string(),
  packaging: z.enum(['packaged', 'standalone_optional', 'optional_upgrade']),
  /** Packaged benefits are always included; optional ones when selected. */
  selected: z.boolean(),
  /** Whether an optional benefit can be chosen now, and why not. */
  available: z.boolean(),
  reason: z.string().nullable(),
  /** The benefit's premium for the whole policy, or null when it is not rated on its own or not included. */
  premium: z.string().nullable(),
  /** When its cover would start and end if bound today; null when not included. */
  coverageStart: localDateTime.nullable(),
  coverageEnd: localDateTime.nullable(),
});

export const QuotePremiumSchema = z.object({
  kind: z.enum(['premium', 'loss_cost', 'mixed']),
  illustrative: z.boolean(),
  total: z.string(),
  perBenefit: z.array(z.object({ benefit: z.string(), total: z.string() })),
  perTraveller: z.array(z.object({ travellerId: z.string(), total: z.string() })),
  basis: z
    .object({
      basis: z.string(),
      amount: z.string(),
      unit: z.string(),
      method: z.string(),
      approved: z.boolean(),
      fixedFeePerPolicy: z.string().nullable(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      benefit: z.string(),
      travellerId: z.string(),
      amount: z.string(),
      worksheetId: z.uuid(),
    }),
  ),
});

export const DisclosureSchema = z.object({
  version: z.string(),
  state: z.string(),
  title: z.string(),
  text: z.string(),
});
export type Disclosure = z.infer<typeof DisclosureSchema>;

export const QuoteSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  status: z.enum(['open', 'bound', 'expired']),
  /** Counts re-rating by selection changes; the quote ID stays the same. */
  revision: z.number().int(),
  state: z.string(),
  plan: z.object({
    planId: z.uuid(),
    code: z.string(),
    name: z.string(),
    versionId: z.uuid(),
    version: z.number().int(),
    term: z.enum(['single_trip', 'annual']),
  }),
  ruleSet: z.object({ id: z.uuid(), version: z.number().int() }),
  manuals: z.record(
    z.string(),
    z.object({ id: z.uuid(), code: z.string(), version: z.number().int() }),
  ),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  travellers: z.array(
    z.object({
      id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      dateOfBirth: date.nullable(),
      age: z.number().int().nullable(),
      costPerTraveller: z.string(),
    }),
  ),
  trip: z.record(z.string(), z.unknown()),
  selection: z.array(z.string()),
  benefits: z.array(QuoteBenefitSchema),
  /** Eligibility at quote: eligible, ineligible, referred or held. */
  outcome: z.enum(['eligible', 'ineligible', 'referred', 'held']),
  reasons: z.array(z.string()),
  waiver: z.object({ applies: z.boolean() }),
  cfar: z.object({ offered: z.boolean(), reasons: z.array(z.string()) }),
  premium: QuotePremiumSchema.nullable(),
  disclosure: DisclosureSchema.nullable(),
  /** Whether the quote can be bound as it stands, and if not, why. */
  bindable: z.boolean(),
  notBindable: z.array(z.string()),
  evaluation: EvaluationResultSchema,
});
export type Quote = z.infer<typeof QuoteSchema>;

// ---------------- Bind ----------------

export const BindRequestSchema = z.object({
  /** The traveller's confirmation that they are able to travel, as the eligibility notice states. */
  ableToTravel: z.literal(true),
  acknowledgement: z.object({
    disclosureVersion: z.string().min(1).max(100),
    acknowledgedBy: z.string().trim().min(2).max(200),
  }),
  /** The payment system's confirmation of the premium. */
  payment: z.object({ reference: z.string().trim().min(3).max(100), amount: money }),
  purchaser: z.object({ name: z.string().trim().min(2).max(200), email: z.email().optional() }),
});
export type BindRequest = z.infer<typeof BindRequestSchema>;

// ---------------- Policy ----------------

export const POLICY_STATUSES = ['active', 'cancelled', 'expired'] as const;
/** The only status changes allowed (E05-F01-S01). */
export const POLICY_TRANSITIONS: Record<
  (typeof POLICY_STATUSES)[number],
  readonly (typeof POLICY_STATUSES)[number][]
> = {
  active: ['cancelled', 'expired'],
  cancelled: [],
  expired: [],
};

export const PolicyBenefitSchema = z.object({
  code: z.string(),
  name: z.string(),
  group: z.string(),
  packaging: z.string(),
  underwriter: z.enum(ARRANGEMENTS).nullable(),
  /** Filed limits at the time of bind, as the plan's values give them. */
  limits: z.object({ maximum: z.number().nullable(), basis: z.string().nullable() }),
  premium: z.string().nullable(),
  coverageStart: localDateTime,
  coverageEnd: localDateTime,
});

export const PolicySnapshotSchema = z.object({
  number: z.string(),
  quoteId: z.uuid(),
  plan: z.object({
    planId: z.uuid(),
    code: z.string(),
    name: z.string(),
    versionId: z.uuid(),
    version: z.number().int(),
    state: z.string(),
    term: z.enum(['single_trip', 'annual']),
  }),
  ruleSet: z.object({ id: z.uuid(), version: z.number().int() }),
  manuals: z.record(
    z.string(),
    z.object({ id: z.uuid(), code: z.string(), version: z.number().int() }),
  ),
  disclosure: z.object({
    version: z.string(),
    title: z.string(),
    acknowledgedBy: z.string(),
    acknowledgedAt: z.iso.datetime({ offset: true }),
  }),
  payment: z.object({ reference: z.string(), amount: z.string() }),
  purchaser: z.object({ name: z.string(), email: z.string().nullable() }),
  travellers: z.array(
    z.object({
      id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      dateOfBirth: date.nullable(),
      age: z.number().int().nullable(),
      costPerTraveller: z.string(),
    }),
  ),
  trip: z.record(z.string(), z.unknown()),
  benefits: z.array(PolicyBenefitSchema),
  premium: z.object({
    kind: z.enum(['premium', 'loss_cost', 'mixed']),
    total: z.string(),
    perBenefit: z.array(z.object({ benefit: z.string(), total: z.string() })),
    perTraveller: z.array(z.object({ travellerId: z.string(), total: z.string() })),
    basis: z.unknown().nullable(),
  }),
  purchasedOn: date,
  reviewPeriodEndsAt: localDateTime.nullable(),
  /** The policy term: for an annual policy, from its effective date to 11:59 p.m. on the 364th day after it. */
  term: z.object({ start: localDateTime, end: localDateTime }),
  waiver: z.object({
    applies: z.boolean(),
    conditions: z.array(z.object({ code: z.string(), passed: z.boolean(), detail: z.string() })),
  }),
  cfar: z.object({ offered: z.boolean(), noticePeriod: z.number().nullable() }),
});
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;

export const PolicyEventSchema = z.object({
  seq: z.number().int(),
  type: z.enum(['bound', 'status_changed', 'details_changed']),
  occurredAt: z.iso.datetime({ offset: true }),
  actor: z.string(),
  actorName: z.string().nullable(),
  reason: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type PolicyEvent = z.infer<typeof PolicyEventSchema>;

export const PolicySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  accountId: z.uuid(),
  status: z.enum(POLICY_STATUSES),
  /** The record as of `asOf`, or now. */
  asOf: z.iso.datetime({ offset: true }).nullable(),
  record: PolicySnapshotSchema,
  history: z.array(PolicyEventSchema),
});
export type Policy = z.infer<typeof PolicySchema>;

export const PolicySummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  accountId: z.uuid(),
  status: z.enum(POLICY_STATUSES),
  planCode: z.string(),
  state: z.string(),
  purchasedOn: date,
  coverageStart: localDateTime,
  coverageEnd: localDateTime,
  premiumTotal: z.string(),
  travellers: z.array(z.string()),
});

// ---------------- Cover verification (E05-F05-S01) ----------------

export const PolicyVerificationRequestSchema = z.object({
  policyNumber: z.string().trim().min(3).max(40),
  /** The date and time cover is asked about, as a local date-time or a date (taken as the end of that day). */
  on: z.union([localDateTime, date]),
});

export const PolicyVerificationSchema = z.object({
  found: z.boolean(),
  policyNumber: z.string(),
  status: z.enum(POLICY_STATUSES).nullable(),
  on: localDateTime,
  inForce: z.boolean(),
  benefits: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      underwriter: z.enum(ARRANGEMENTS).nullable(),
      limits: z.object({ maximum: z.number().nullable(), basis: z.string().nullable() }),
      coverageStart: localDateTime,
      coverageEnd: localDateTime,
      inForceOnDate: z.boolean(),
    }),
  ),
  travellers: z.array(z.string()),
  plan: z.string().nullable(),
  reasons: z.array(z.string()),
});
export type PolicyVerification = z.infer<typeof PolicyVerificationSchema>;
