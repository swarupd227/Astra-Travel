import { z } from 'zod';

/** Increment 16e: mapping an issuer’s own file to the eligibility feed format, and explaining rejected records (E21-F04-S01). Design: docs/adr/0021. */

export const FEED_DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'MM/DD/YYYY', 'DD/MM/YYYY'] as const;
const column = z.string().trim().min(1).max(100);
const values = z.record(z.string().max(100), z.string().max(100)).default({});

export const FeedMappingDocumentSchema = z.object({
  delimiter: z.enum([',', ';', '|', '\t']),
  /** The first line names the columns. */
  columns: z.object({
    accountRef: z.object({ column }),
    /** Either a column of the file, with an optional translation of its values, or one product for every record. */
    productCode: z.union([z.object({ column, values }), z.object({ constant: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/) })]),
    /** A, U or D: from a column translated to those, or the same for every record (a full file is all A). */
    action: z.union([z.object({ column, values }), z.object({ constant: z.enum(['A', 'U', 'D']) })]),
    eligibleFrom: z.object({ column, format: z.enum(FEED_DATE_FORMATS) }),
    eligibleTo: z.object({ column, format: z.enum(FEED_DATE_FORMATS) }).nullable(),
  }),
});
export type FeedMappingDocument = z.infer<typeof FeedMappingDocumentSchema>;

export const FeedSampleSchema = z.object({
  id: z.uuid(),
  programmeId: z.uuid(),
  fileName: z.string(),
  /** The first lines of the issuer’s file, with anything that looks like a card number removed before it was stored. */
  text: z.string(),
  lines: z.number().int(),
  cardNumbersRemoved: z.number().int(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});
export type FeedSample = z.infer<typeof FeedSampleSchema>;

export const FeedMappingPreviewSchema = z.object({
  /** Columns named by the mapping that the file does not have. When there are any, nothing is converted. */
  missingColumns: z.array(z.string()),
  records: z.number().int(),
  converted: z.number().int(),
  rejected: z.number().int(),
  sample: z.array(z.object({ line: z.number().int(), accountRef: z.string(), productCode: z.string(), action: z.string(), eligibleFrom: z.string(), eligibleTo: z.string().nullable() })),
  problems: z.array(z.object({ line: z.number().int(), code: z.string(), message: z.string() })),
});
export type FeedMappingPreview = z.infer<typeof FeedMappingPreviewSchema>;

export const FeedMappingSchema = z.object({
  id: z.uuid(),
  programmeId: z.uuid(),
  version: z.number().int(),
  status: z.enum(['approved', 'superseded']),
  document: FeedMappingDocumentSchema,
  proposalId: z.uuid().nullable(),
  approvedBy: z.string(),
  approvedAt: z.iso.datetime(),
});
export type FeedMapping = z.infer<typeof FeedMappingSchema>;

export const ApproveFeedMappingSchema = z.object({
  document: FeedMappingDocumentSchema,
  /** The agent’s proposal this came from; approving resolves it, recording whether the mapping was changed first. */
  proposalId: z.uuid().optional(),
  sampleId: z.uuid(),
});

export const RejectionExplanationSchema = z.object({
  /** A rejection code of the feed. */
  code: z.string().min(1).max(40),
  /** What went wrong, in plain language, for the programme manager and the issuer. */
  explanation: z.string().trim().min(10).max(1000),
  fix: z.discriminatedUnion('kind', [
    /** The platform’s mapping should change: the whole corrected mapping. */
    z.object({ kind: z.literal('mapping'), detail: z.string().trim().min(10).max(1000), mapping: FeedMappingDocumentSchema }),
    /** The issuer must correct what it sends. */
    z.object({ kind: z.literal('issuer'), detail: z.string().trim().min(10).max(1000) }),
  ]),
});
export type RejectionExplanation = z.infer<typeof RejectionExplanationSchema>;

export const DecideExplanationsSchema = z.object({
  decisions: z.array(z.object({ code: z.string().min(1).max(40), decision: z.enum(['approved', 'rejected']) })).min(1).max(40),
  note: z.string().trim().max(1000).optional(),
});
