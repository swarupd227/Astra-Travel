import { z } from 'zod';

/**
 * Benefit catalogue (E01-F02-S01/S02/S03). Built from a schedule edition and, optionally, its policy form
 * edition. Every amount, basis and optional item refers to a variable in one of those documents' approved
 * variable maps, so filed ranges live in one place.
 */

export const BENEFIT_GROUPS = [
  'pre_departure',
  'post_departure',
  'baggage',
  'rental_accommodation',
  'activities_events',
  'medical_evacuation',
  'accident',
] as const;

export const BENEFIT_GROUP_LABELS: Record<(typeof BENEFIT_GROUPS)[number], string> = {
  pre_departure: 'Pre-departure',
  post_departure: 'Post-departure trip',
  baggage: 'Baggage',
  rental_accommodation: 'Rental and accommodation',
  activities_events: 'Activities and events',
  medical_evacuation: 'Medical and evacuation',
  accident: 'Accident',
};

export const LIMIT_BASES = ['per_person', 'per_trip', 'per_reservation', 'per_policy'] as const;
export const LIMIT_BASIS_LABELS: Record<(typeof LIMIT_BASES)[number], string> = {
  per_person: 'Per person',
  per_trip: 'Per trip',
  per_reservation: 'Per reservation',
  per_policy: 'Per policy',
};

export const COVERAGE_LEVELS = [
  'self',
  'family_member',
  'travelling_companion',
  'business_partner',
  'host_at_destination',
] as const;
export const COVERAGE_LEVEL_LABELS: Record<(typeof COVERAGE_LEVELS)[number], string> = {
  self: 'Self',
  family_member: 'Family member',
  travelling_companion: 'Travelling companion',
  business_partner: 'Business partner',
  host_at_destination: 'Host at destination',
};

export const REASON_BENEFITS = ['trip_cancellation', 'trip_interruption'] as const;
export const UPGRADE_KINDS = [
  'covered_reason_set',
  'benefit_package',
  'sports',
  'limit_replacement',
] as const;
export const UPGRADE_KIND_LABELS: Record<(typeof UPGRADE_KINDS)[number], string> = {
  covered_reason_set: 'Additional covered reasons',
  benefit_package: 'Benefit package',
  sports: 'Sports upgrade',
  limit_replacement: 'Replaces base limits',
};

const CODE = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'Lower-case letters, digits and _, starting with a letter');

/** A variable in the schedule's or the policy form's approved variable map. */
export const VariableRefSchema = z.object({
  source: z.enum(['schedule', 'policy']),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
});
export type VariableRef = z.infer<typeof VariableRefSchema>;

/** The basis of an amount: fixed by the form, or chosen per plan through a limit-basis variable. */
export const BasisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), basis: z.enum(LIMIT_BASES) }),
  z.object({ kind: z.literal('variable'), variable: VariableRefSchema }),
]);

export const AmountSchema = z.object({ variable: VariableRefSchema, basis: BasisSchema });
export type Amount = z.infer<typeof AmountSchema>;

export const SubLimitSchema = z.object({
  code: CODE,
  name: z.string().trim().min(2).max(200),
  amount: AmountSchema,
  /** True when the schedule says the sub-limit is part of the parent maximum, not paid in addition. */
  includedInParent: z.boolean(),
  optional: VariableRefSchema.nullable().default(null),
});

export const EventAmountSchema = z.object({
  code: CODE,
  event: z.string().trim().min(2).max(200),
  amount: VariableRefSchema,
});

export const BenefitSchema = z.object({
  code: CODE,
  name: z.string().trim().min(2).max(200),
  group: z.enum(BENEFIT_GROUPS),
  /** The optional-benefit variable that includes the benefit in a plan; null when always included. */
  optional: VariableRefSchema.nullable().default(null),
  maximum: AmountSchema,
  perDay: AmountSchema.nullable().default(null),
  deductible: AmountSchema.nullable().default(null),
  subLimits: z.array(SubLimitSchema).max(50).default([]),
  eventAmounts: z.array(EventAmountSchema).max(100).default([]),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type Benefit = z.infer<typeof BenefitSchema>;

export const CoveredReasonSchema = z.object({
  code: CODE,
  text: z.string().trim().min(3).max(1000),
  category: z.string().trim().min(2).max(100),
  appliesTo: z.array(z.enum(REASON_BENEFITS)).min(1),
  coverageLevels: z.array(z.enum(COVERAGE_LEVELS)).min(1),
  /** The peril number in the rating manual; required before the catalogue is approved. */
  perilNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.-]{1,10}$/, 'As numbered in the manual, for example 12 or 12a')
    .nullable()
    .default(null),
  /** The upgrade that adds this reason, when it is not in the base set. */
  upgrade: CODE.nullable().default(null),
});
export type CoveredReason = z.infer<typeof CoveredReasonSchema>;

export const ReplacementTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('benefit'),
    benefit: CODE,
    field: z.enum(['maximum', 'perDay', 'deductible']),
  }),
  z.object({ kind: z.literal('sub_limit'), benefit: CODE, subLimit: CODE }),
]);

export const UpgradeSchema = z.object({
  code: CODE,
  name: z.string().trim().min(2).max(200),
  kind: z.enum(UPGRADE_KINDS),
  /** The optional-benefit variable that offers the upgrade. */
  offeredBy: VariableRefSchema,
  /** Benefits the upgrade adds (packages and sports upgrades). */
  benefits: z.array(CODE).max(50).default([]),
  /** Limits the upgrade replaces when it is bought (for example the Increased Medical Benefit Package). */
  replacements: z
    .array(z.object({ target: ReplacementTargetSchema, amount: AmountSchema }))
    .max(50)
    .default([]),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type Upgrade = z.infer<typeof UpgradeSchema>;

export const CatalogueDocumentSchema = z.object({
  benefits: z.array(BenefitSchema),
  coveredReasons: z.array(CoveredReasonSchema),
  upgrades: z.array(UpgradeSchema),
});
export type CatalogueDocument = z.infer<typeof CatalogueDocumentSchema>;

export const CatalogueProblemSchema = z.object({ path: z.string(), message: z.string() });
export type CatalogueProblem = z.infer<typeof CatalogueProblemSchema>;

export const BenefitCatalogueSchema = z.object({
  id: z.uuid(),
  scheduleEditionId: z.uuid(),
  policyEditionId: z.uuid().nullable(),
  version: z.number().int(),
  status: z.enum(['draft', 'approved', 'superseded']),
  document: CatalogueDocumentSchema,
  /** Problems that block approval (invalid references, missing peril numbers). */
  problems: z.array(CatalogueProblemSchema),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  contributors: z.array(z.string()),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
  approvalNote: z.string().nullable(),
});
export type BenefitCatalogue = z.infer<typeof BenefitCatalogueSchema>;

export const StartCatalogueRequestSchema = z.object({
  policyEditionId: z.uuid().nullable().optional(),
});
