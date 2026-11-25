import { z } from 'zod';

/** Policy documents: templates, issued documents, delivery and the Guide to Benefits (E09, E21-F05). Design: docs/adr/0011. */

export const TEMPLATE_KINDS = ['schedule', 'policy'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const DOCUMENT_KINDS = ['schedule', 'policy', 'purchase_confirmation', 'change_notice', 'cancellation_notice', 'guide_to_benefits'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  schedule: 'Schedule',
  policy: 'Policy',
  purchase_confirmation: 'Purchase confirmation',
  change_notice: 'Notice of change',
  cancellation_notice: 'Notice of cancellation or expiry',
  guide_to_benefits: 'Guide to Benefits',
};

// ---------------- Templates ----------------

export const TemplateCheckSchema = z.object({
  check: z.enum(['assembled', 'accounted', 'in_range', 'quality']),
  passed: z.boolean(),
  detail: z.string(),
});
export type TemplateCheck = z.infer<typeof TemplateCheckSchema>;

export const TemplateSchema = z.object({
  id: z.uuid(),
  planVersionId: z.uuid(),
  planCode: z.string(),
  planName: z.string(),
  planVersion: z.number().int(),
  kind: z.enum(TEMPLATE_KINDS),
  version: z.number().int(),
  status: z.enum(['draft', 'released', 'superseded']),
  form: z.object({ editionId: z.uuid(), formNumber: z.string(), edition: z.string(), mapId: z.uuid(), mapVersion: z.number().int() }),
  /** The assembled wording, with the plan's values in the filed format. */
  text: z.string(),
  problems: z.array(z.object({ variable: z.string().nullable(), message: z.string() })),
  inserted: z.number().int(),
  removed: z.array(z.string()),
  checks: z.array(TemplateCheckSchema),
  /** Open findings of the Document Quality agent that hold the release, and accepted ones that block it for good. */
  holds: z.object({ open: z.number().int(), accepted: z.number().int() }),
  releasable: z.boolean(),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  releasedBy: z.string().nullable(),
  releasedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Template = z.infer<typeof TemplateSchema>;

export const TemplateSummarySchema = TemplateSchema.omit({ text: true, problems: true, removed: true, checks: true });

export const CreateTemplateRequestSchema = z.object({ planVersionId: z.uuid(), kind: z.enum(TEMPLATE_KINDS) });
export const ReleaseTemplateRequestSchema = z.object({ note: z.string().trim().max(1000).optional() });

// ---------------- Issued documents ----------------

export const DocumentDeliverySchema = z.object({
  id: z.uuid(),
  channel: z.enum(['email', 'account']),
  recipient: z.string().nullable(),
  status: z.enum(['queued', 'sent', 'available', 'failed']),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  nextAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  deliveredAt: z.iso.datetime({ offset: true }).nullable(),
});
export type DocumentDelivery = z.infer<typeof DocumentDeliverySchema>;

export const IssuedDocumentSchema = z.object({
  id: z.uuid(),
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string(),
  status: z.enum(['issued', 'failed']),
  failure: z.string().nullable(),
  accountId: z.uuid(),
  policyId: z.uuid().nullable(),
  policyNumber: z.string().nullable(),
  programmeId: z.uuid().nullable(),
  templateId: z.uuid().nullable(),
  /** The builder or template version that produced it. */
  source: z.string().nullable(),
  /** Guide to Benefits version, for guides. */
  version: z.number().int().nullable(),
  sha256: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  issuedAt: z.iso.datetime({ offset: true }),
  deliveries: z.array(DocumentDeliverySchema),
});
export type IssuedDocument = z.infer<typeof IssuedDocumentSchema>;

export const IssuedDocumentDetailSchema = IssuedDocumentSchema.extend({ text: z.string().nullable() });

export const FailedDeliverySchema = DocumentDeliverySchema.extend({
  documentId: z.uuid(),
  documentKind: z.enum(DOCUMENT_KINDS),
  policyNumber: z.string().nullable(),
  accountId: z.uuid(),
});

/** Documents for a change or cancellation: the policy event they describe. */
export const IssueNoticeRequestSchema = z.object({
  /** The `seq` of the policy event (a change or a status change) the notice is about. */
  eventSeq: z.number().int().min(1),
});

export const GuideRequestSchema = z.object({
  planCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/),
  /** The state the guide is for; the plan version in force there is used. Defaults to the plan's own state. */
  asOf: z.iso.date().optional(),
});

// ---------------- AG-07 findings ----------------

export const DocumentFindingSchema = z.object({
  /** Text the agent says is wrong, copied exactly from the document. The platform checks it is there. */
  quote: z.string().min(3).max(500),
  issue: z.string().trim().min(5).max(1000),
  /** `hold` findings hold a template's release; `note` findings are for the reviewer's information. */
  severity: z.enum(['hold', 'note']).default('hold'),
});
export type DocumentFinding = z.infer<typeof DocumentFindingSchema>;
