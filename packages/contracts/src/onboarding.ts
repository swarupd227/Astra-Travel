import { z } from 'zod';
import { BillingBasisSchema, RATING_INPUTS } from './rating';

/** Account onboarding and configuration: profile, segment, collected variables, licences, sandbox (E07). Design: docs/adr/0014. */

const date = z.iso.date();
const STATE = z.string().regex(/^[A-Z]{2}$/);
const PLAN_CODE = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/);

export const INTEGRATION_METHODS = ['api', 'files', 'mulesoft', 'widget'] as const;
export const INTEGRATION_LABELS: Record<(typeof INTEGRATION_METHODS)[number], string> = {
  api: 'Direct API',
  files: 'Batch files',
  mulesoft: 'MuleSoft',
  widget: 'Embedded widget',
};

// ---------------- Profile ----------------

export const SettlementTermsSchema = z.object({
  /** How the account settles premium with Assurant, in the contract's words. */
  description: z.string().trim().min(3).max(1000),
  /** Days after statement date the account pays; null when the contract states none. */
  paymentDays: z.number().int().min(0).max(365).nullable().default(null),
});

export const AccountProfileInputSchema = z.object({
  contractReference: z.string().trim().min(2).max(100).nullable().optional(),
  contractSignedOn: date.nullable().optional(),
  states: z.array(STATE).max(60).optional(),
  plans: z.array(PLAN_CODE).max(60).optional(),
  integrationMethod: z.enum(INTEGRATION_METHODS).nullable().optional(),
  rateBasis: BillingBasisSchema.nullable().optional(),
  settlement: SettlementTermsSchema.nullable().optional(),
});
export type AccountProfileInput = z.infer<typeof AccountProfileInputSchema>;

export const AccountProfileSchema = z.object({
  accountId: z.uuid(),
  contractReference: z.string().nullable(),
  contractSignedOn: date.nullable(),
  states: z.array(z.string()),
  plans: z.array(z.string()),
  integrationMethod: z.enum(INTEGRATION_METHODS).nullable(),
  rateBasis: BillingBasisSchema.nullable(),
  settlement: SettlementTermsSchema.nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: z.string(),
});
export type AccountProfile = z.infer<typeof AccountProfileSchema>;

// ---------------- Segment (E07-F02-S01) ----------------

export const SegmentChangeRequestSchema = z.object({
  segment: z.string().regex(/^[A-Z0-9_]{2,40}$/),
  effectiveFrom: date,
  reason: z.string().trim().min(3).max(500),
});
export const SegmentChangeSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  segment: z.string(),
  segmentName: z.string().nullable(),
  effectiveFrom: date,
  status: z.enum(['pending', 'approved', 'declined']),
  reason: z.string(),
  requestedBy: z.string(),
  requestedAt: z.iso.datetime({ offset: true }),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  decisionNote: z.string().nullable(),
});
export type SegmentChange = z.infer<typeof SegmentChangeSchema>;
export const DecideSegmentSchema = z.object({
  decision: z.enum(['approve', 'decline']),
  note: z.string().trim().min(3).max(500),
});

// ---------------- Collected variables (E07-F02-S02) ----------------

export const CollectedVariablesSchema = z.object({
  /** The rating inputs the account does not collect; the filed "not collected" factors apply to these. */
  notCollected: z.array(z.enum(RATING_INPUTS)).max(RATING_INPUTS.length),
  reason: z.string().trim().min(3).max(500),
});
export const CollectedVariablesViewSchema = z.object({
  decided: z.boolean(),
  notCollected: z.array(z.enum(RATING_INPUTS)),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  reason: z.string().nullable(),
});

// ---------------- Licences (E07-F03-S01) ----------------

export const LICENCE_KINDS = ['retailer_registration', 'producer_licence'] as const;
export const LICENCE_KIND_LABELS: Record<(typeof LICENCE_KINDS)[number], string> = {
  retailer_registration: 'Travel retailer registration',
  producer_licence: 'Producer licence',
};

export const CreateLicenceSchema = z
  .object({
    kind: z.enum(LICENCE_KINDS),
    state: STATE,
    number: z.string().trim().min(1).max(60),
    holder: z.string().trim().min(2).max(200),
    validFrom: date,
    expiresOn: date,
  })
  .refine((l) => l.expiresOn > l.validFrom, {
    message: 'The licence expires before it starts',
    path: ['expiresOn'],
  });

export const LicenceSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  accountName: z.string().nullable(),
  kind: z.enum(LICENCE_KINDS),
  state: z.string(),
  number: z.string(),
  holder: z.string(),
  validFrom: date,
  expiresOn: date,
  status: z.enum(['active', 'revoked']),
  /** Whether it allows sales today: active and within its dates. */
  inForce: z.boolean(),
  daysLeft: z.number().int(),
  alertsSent: z.array(z.number().int()),
  createdBy: z.string(),
});
export type Licence = z.infer<typeof LicenceSchema>;
export const LICENCE_ALERT_DAYS = [60, 30] as const;

// ---------------- Onboarding checklist (E07-F01-S01) ----------------

export const ONBOARDING_ITEMS = [
  'contract',
  'licences',
  'segment',
  'plans',
  'states',
  'integration',
  'rate_basis',
  'settlement',
  'collected_variables',
  'tested',
] as const;
export type OnboardingItem = (typeof ONBOARDING_ITEMS)[number];
export const ONBOARDING_LABELS: Record<OnboardingItem, string> = {
  contract: 'Contract signed and referenced',
  licences: 'A licence or registration in every state sold',
  segment: 'Business segment approved by an underwriter',
  plans: 'Plans published for each state',
  states: 'States the account sells in',
  integration: 'Integration method',
  rate_basis: 'Billing basis agreed',
  settlement: 'Settlement terms',
  collected_variables: 'Rating variables the account collects',
  tested: 'Tested in the sandbox: a quote and a bind',
};

export const OnboardingSchema = z.object({
  accountId: z.uuid(),
  accountStatus: z.enum(['onboarding', 'active', 'suspended', 'closed']),
  sandbox: z.boolean(),
  items: z.array(
    z.object({
      item: z.enum(ONBOARDING_ITEMS),
      label: z.string(),
      complete: z.boolean(),
      detail: z.string(),
    }),
  ),
  complete: z.boolean(),
  sandboxAccountId: z.uuid().nullable(),
  liveAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Onboarding = z.infer<typeof OnboardingSchema>;

export const GoLiveSchema = z.object({ note: z.string().trim().min(3).max(500) });

// ---------------- Contract documents and AG-05 ----------------

export const AccountDocumentSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  kind: z.enum(['contract', 'term_sheet']),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  pages: z.number().int(),
  uploadedBy: z.string(),
  uploadedAt: z.iso.datetime({ offset: true }),
});
export type AccountDocument = z.infer<typeof AccountDocumentSchema>;

/** The profile fields an agent may draft, each with the wording it comes from. */
export const ONBOARDING_FIELDS = [
  'contractReference',
  'contractSignedOn',
  'states',
  'plans',
  'integrationMethod',
  'rateBasis',
  'settlement',
  'segment',
  'notCollected',
] as const;
export const OnboardingFieldProposalSchema = z.object({
  field: z.enum(ONBOARDING_FIELDS),
  value: z.unknown(),
  /** The document the wording is in, and the exact text of it. */
  documentId: z.uuid(),
  excerpt: z.string().min(3).max(800),
  note: z.string().trim().max(500).optional(),
});
export type OnboardingFieldProposal = z.infer<typeof OnboardingFieldProposalSchema>;

// ---------------- Sandbox (E07-F03-S02) ----------------

export const SandboxCredentialsSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  tokenUrl: z.string(),
  accountId: z.uuid(),
  note: z.string(),
});
export const SandboxStatusSchema = z.object({
  accountId: z.uuid().nullable(),
  code: z.string().nullable(),
  credentials: z.array(
    z.object({
      clientId: z.string(),
      issuedAt: z.iso.datetime({ offset: true }),
      issuedBy: z.string(),
      revokedAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
  quotes: z.number().int(),
  policies: z.number().int(),
});
