import { FeedMappingDocumentSchema, RejectionExplanationSchema } from './feed-mapping';
import { z } from 'zod';
import { FormVariableInputSchema } from './studio';
import { CreateManualRequestSchema } from './rating';
import { DocumentFindingSchema } from './documents';
import { OnboardingFieldProposalSchema } from './onboarding';

/** Agent proposals (E01-F01-S03, E02-F01-S02, E02-F07-S03). Design: docs/adr/0009. */

export const PROPOSAL_KINDS = [
  'variable_map',
  'rate_manual',
  'parity_explanation',
  'document_quality',
  'account_onboarding',
  'feed_mapping',
  'feed_rejections',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_KIND_LABELS: Record<ProposalKind, string> = {
  variable_map: 'Variable map',
  rate_manual: 'Rate manual draft',
  parity_explanation: 'Parity explanation',
  document_quality: 'Document quality findings',
  account_onboarding: 'Account onboarding draft',
  feed_mapping: 'Eligibility feed mapping',
  feed_rejections: 'Rejected records explained',
};

// ---------------- What an agent submits ----------------

export const VariableProposalSchema = z.object({
  variable: FormVariableInputSchema,
  /** Why the agent reads this wording as this variable. */
  rationale: z.string().trim().min(5).max(500),
});
export type VariableProposal = z.infer<typeof VariableProposalSchema>;

export const SubmitVariableMapSchema = z.object({
  kind: z.literal('variable_map'),
  editionId: z.uuid(),
  summary: z.string().trim().min(5).max(1000),
  items: z.array(VariableProposalSchema).min(1).max(300),
});

export const SubmitRateManualSchema = z.object({
  kind: z.literal('rate_manual'),
  /** The rate manual document in the form library. */
  editionId: z.uuid(),
  summary: z.string().trim().min(5).max(1000),
  manual: CreateManualRequestSchema.pick({
    code: true,
    state: true,
    benefit: true,
    effectiveFrom: true,
    document: true,
  }),
  /** What the agent could not read or was unsure of, for the analyst. */
  uncertainties: z.array(z.string().trim().min(3).max(500)).max(50).default([]),
});

export const ParityExplanationItemSchema = z.object({
  caseId: z.uuid(),
  /** The worksheet step where engine and workbook diverge, for example table.2.1.4. */
  step: z.string().min(1).max(100),
  explanation: z.string().trim().min(10).max(1500),
  /** The manual page of the step's table, as the manual gives it. */
  manualPage: z.string().min(1).max(100),
  /** The cell of the imported workbook file that holds the expected value. */
  workbookCell: z.object({ row: z.number().int().min(1), column: z.string().min(1).max(100) }),
});

export const SubmitParityExplanationSchema = z.object({
  kind: z.literal('parity_explanation'),
  manualId: z.uuid(),
  summary: z.string().trim().min(5).max(1000),
  items: z.array(ParityExplanationItemSchema).min(1).max(200),
});

export const SubmitDocumentQualitySchema = z.object({
  kind: z.literal('document_quality'),
  subjectType: z.enum(['document_template', 'document']),
  subjectId: z.uuid(),
  summary: z.string().trim().min(5).max(1000),
  /** Empty when the agent found nothing wrong: the proposal then records that the document was checked. */
  findings: z.array(DocumentFindingSchema).max(100),
});

export const SubmitAccountOnboardingSchema = z.object({
  kind: z.literal('account_onboarding'),
  accountId: z.uuid(),
  summary: z.string().trim().min(5).max(1000),
  /** Each field with the wording of the contract or term sheet it comes from. */
  fields: z.array(OnboardingFieldProposalSchema).min(1).max(40),
});

export const SubmitFeedMappingSchema = z.object({
  kind: z.literal('feed_mapping'),
  programmeId: z.uuid(),
  sampleId: z.uuid(),
  summary: z.string().trim().min(5).max(1000),
  mapping: FeedMappingDocumentSchema,
});

export const SubmitFeedRejectionsSchema = z.object({
  kind: z.literal('feed_rejections'),
  programmeId: z.uuid(),
  feedId: z.uuid(),
  summary: z.string().trim().min(5).max(1000),
  explanations: z.array(RejectionExplanationSchema).min(1).max(40),
});

export const SubmitProposalSchema = z.discriminatedUnion('kind', [
  SubmitVariableMapSchema,
  SubmitRateManualSchema,
  SubmitParityExplanationSchema,
  SubmitDocumentQualitySchema,
  SubmitAccountOnboardingSchema,
  SubmitFeedMappingSchema,
  SubmitFeedRejectionsSchema,
]);
export type SubmitProposal = z.infer<typeof SubmitProposalSchema>;

// ---------------- What is stored and shown ----------------

export const ProposalCheckSchema = z.object({
  /** variable key, table id or case id */
  item: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

export const ProposalSchema = z.object({
  id: z.uuid(),
  kind: z.enum(PROPOSAL_KINDS),
  agentId: z.string(),
  agentName: z.string(),
  runId: z.uuid().nullable(),
  requestedBy: z.string(),
  subjectType: z.enum([
    'form_edition',
    'rate_manual',
    'document_template',
    'document',
    'account',
    'card_programme',
    'card_feed',
  ]),
  subjectId: z.uuid(),
  summary: z.string(),
  content: z.record(z.string(), z.unknown()),
  /** The platform's own checks of the content, item by item. */
  verification: z.array(ProposalCheckSchema),
  status: z.enum(['open', 'resolved', 'withdrawn']),
  createdAt: z.iso.datetime({ offset: true }),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  resolution: z.record(z.string(), z.unknown()).nullable(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ResolveProposalSchema = z.object({
  accepted: z.array(z.string()).max(500).default([]),
  corrected: z.array(z.string()).max(500).default([]),
  rejected: z.array(z.string()).max(500).default([]),
  /** What was created from the proposal, for example the variable map or draft manual. */
  appliedTo: z
    .object({ type: z.enum(['variable_map', 'rate_manual']), id: z.uuid() })
    .nullable()
    .default(null),
  note: z.string().trim().max(1000).optional(),
});
export type ResolveProposal = z.infer<typeof ResolveProposalSchema>;
