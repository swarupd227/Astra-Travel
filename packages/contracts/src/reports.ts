import { z } from 'zod';

/** Increment 16a: the audit trace (E10-F02-S01), statutory data (E10-F02-S02) and account reports (E12-F02-S01). Design: docs/adr/0017. */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A reporting period, both ends included, of at most two years. */
export const ReportPeriodSchema = z
  .object({ from: day, to: day })
  .refine((p) => p.to >= p.from, { message: 'The end date is before the start date', path: ['to'] })
  .refine((p) => Date.parse(p.to) - Date.parse(p.from) <= 732 * 86_400_000, {
    message: 'Choose a period of two years or less',
    path: ['to'],
  });

// ---------------------------------------------------------------- Trace

export const TraceSchema = z.object({
  subject: z.object({
    type: z.enum(['premium_record', 'document']),
    id: z.uuid(),
    label: z.string(),
  }),
  generatedAt: z.iso.datetime(),
  generatedBy: z.string(),
  /** The facts about the premium or document itself. */
  record: z.record(z.string(), z.unknown()),
  policy: z
    .object({
      id: z.uuid(),
      number: z.string(),
      state: z.string(),
      accountId: z.uuid(),
      quoteId: z.uuid(),
    })
    .nullable(),
  event: z
    .object({
      seq: z.number().int(),
      type: z.string(),
      actor: z.string(),
      actorName: z.string().nullable(),
      occurredAt: z.iso.datetime(),
      reason: z.string().nullable(),
    })
    .nullable(),
  plan: z
    .object({
      code: z.string(),
      version: z.number().int(),
      versionId: z.uuid(),
      sha256: z.string().nullable(),
      publishedBy: z.string().nullable(),
      publishedAt: z.iso.datetime().nullable(),
      approvedBy: z.string().nullable(),
    })
    .nullable(),
  ruleSet: z
    .object({
      id: z.uuid(),
      version: z.number().int(),
      sha256: z.string().nullable(),
      approvedBy: z.string().nullable(),
      publishedBy: z.string().nullable(),
    })
    .nullable(),
  forms: z.array(
    z.object({
      role: z.string(),
      editionId: z.uuid(),
      formNumber: z.string(),
      edition: z.string(),
      insurer: z.string(),
      sha256: z.string(),
    }),
  ),
  templates: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      version: z.number().int(),
      createdBy: z.string(),
      releasedBy: z.string().nullable(),
      variableMapId: z.uuid(),
      variableMapVersion: z.number().int(),
    }),
  ),
  manuals: z.array(
    z.object({
      id: z.uuid(),
      code: z.string(),
      version: z.number().int(),
      state: z.string(),
      benefit: z.string(),
      sha256: z.string(),
      approvedBy: z.string().nullable(),
      publishedBy: z.string().nullable(),
    }),
  ),
  worksheets: z.array(z.object({ id: z.uuid(), manualId: z.uuid(), inputsHash: z.string() })),
  /** Every agent version that proposed or performed something in this chain. An empty list means no agent did. */
  agents: z.array(
    z.object({
      agentId: z.string(),
      agentVersion: z.number().int(),
      runId: z.uuid(),
      promptVersion: z.string().nullable(),
      models: z.array(z.string()),
      role: z.string(),
    }),
  ),
  /** Anything the chain should contain that could not be found, so a gap is visible rather than silent. */
  gaps: z.array(z.string()),
});
export type Trace = z.infer<typeof TraceSchema>;

// ---------------------------------------------------------------- Statutory and statistical data

export const StatutoryRowSchema = z.object({
  state: z.string(),
  entity: z.string(),
  benefit: z.string(),
  transactions: z.number().int(),
  policies: z.number().int(),
  premium: z.string(),
});
export const StatutoryEntitySchema = z.object({
  state: z.string(),
  entity: z.string(),
  premium: z.string(),
  tax: z.string(),
  recordsWithoutTax: z.number().int(),
});
export const StatutoryReportSchema = z.object({
  from: day,
  to: day,
  generatedAt: z.iso.datetime(),
  rows: z.array(StatutoryRowSchema),
  byEntity: z.array(StatutoryEntitySchema),
  /** The report against the premium records it is built from, which are the accounting totals. */
  reconciliation: z.object({
    records: z.number().int(),
    recordPremium: z.string(),
    reportPremium: z.string(),
    premiumDifference: z.string(),
    recordTax: z.string(),
    reportTax: z.string(),
    taxDifference: z.string(),
    reconciled: z.boolean(),
    /** Premium on records not yet with billing, held for missing data, or rejected: included above and shown here. */
    byStatus: z.array(
      z.object({ status: z.string(), records: z.number().int(), premium: z.string() }),
    ),
    /** Records whose benefit lines do not add up to their premium. Empty when the data is sound. */
    unbalancedRecords: z.array(z.string()),
  }),
});
export type StatutoryReport = z.infer<typeof StatutoryReportSchema>;

// ---------------------------------------------------------------- Account reports

export const SalesRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  policiesSold: z.number().int(),
  premiumCharged: z.string(),
  premiumRefunded: z.string(),
  netPremium: z.string(),
  cancellations: z.number().int(),
  refunds: z.number().int(),
});
export type SalesRow = z.infer<typeof SalesRowSchema>;

export const AccountReportSchema = z.object({
  from: day,
  to: day,
  generatedAt: z.iso.datetime(),
  totals: SalesRowSchema,
  byAccount: z.array(SalesRowSchema),
  bySegment: z.array(SalesRowSchema),
  byState: z.array(SalesRowSchema),
  byBenefit: z.array(SalesRowSchema),
  /** Of the quotes made in the period, how many became policies. */
  conversion: z.array(
    z.object({
      accountId: z.uuid(),
      account: z.string(),
      quotes: z.number().int(),
      bound: z.number().int(),
      rate: z.number(),
    }),
  ),
  /** Of the policies sold in the period, the share that carry each benefit. */
  takeUp: z.array(
    z.object({
      benefit: z.string(),
      name: z.string(),
      policies: z.number().int(),
      of: z.number().int(),
      rate: z.number(),
    }),
  ),
});
export type AccountReport = z.infer<typeof AccountReportSchema>;
