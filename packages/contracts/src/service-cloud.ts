import { z } from 'zod';
import { IssuedDocumentSchema } from './documents';
import { PolicySchema } from './policies';

/** Increment 16c: Salesforce Service Cloud (E14-F02). Design: docs/adr/0019; sample calls: docs/integrations/service-cloud.md. */

/**
 * Find a customer's cover by one thing the customer can give: a policy number, a name with date of birth, or a card
 * issuer's cardholder reference. Sent in the body, so that no personal detail appears in an address or a log of one.
 */
export const CustomerViewRequestSchema = z.union([
  z.strictObject({ policyNumber: z.string().trim().min(6).max(40) }),
  z.strictObject({ lastName: z.string().trim().min(1).max(100), dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.strictObject({ cardholderRef: z.string().trim().min(1).max(100) }),
]);
export type CustomerViewRequest = z.infer<typeof CustomerViewRequestSchema>;

export const CustomerViewSchema = z.object({
  policies: z.array(z.object({ policy: PolicySchema, documents: z.array(IssuedDocumentSchema) })),
  certificates: z.array(
    z.object({
      certificateNumber: z.string(),
      programmeCode: z.string(),
      programmeName: z.string(),
      accountId: z.uuid(),
      cardholderRef: z.string(),
      eligibility: z.array(z.object({ productCode: z.string(), from: z.string(), to: z.string().nullable() })),
      documents: z.array(IssuedDocumentSchema),
    }),
  ),
  /** True when more than the ten most recent policies matched. */
  truncated: z.boolean(),
});
export type CustomerView = z.infer<typeof CustomerViewSchema>;

export const ResendDocumentsRequestSchema = z.object({
  /** Which of the policy's documents to send again; all of those emailed before when not given. */
  documentIds: z.array(z.uuid()).min(1).max(50).optional(),
  reason: z.string().trim().min(3).max(500),
});
export const ResendDocumentsResultSchema = z.object({ queued: z.array(z.object({ documentId: z.uuid(), title: z.string() })), alreadyQueued: z.number().int() });
