import { z } from 'zod';

/** Increment 18: launch readiness by state and go-live sign-off (E16-F01-S01, E16-F02-S01). Design: docs/adr/0023. */

export const SIGNOFF_AREAS = ['product', 'actuarial', 'compliance', 'finance'] as const;
export type SignoffArea = (typeof SIGNOFF_AREAS)[number];

/** The role that signs for each area. */
export const SIGNOFF_ROLES: Record<SignoffArea, 'product_manager' | 'rating_analyst' | 'compliance_officer' | 'finance_analyst'> = {
  product: 'product_manager',
  actuarial: 'rating_analyst',
  compliance: 'compliance_officer',
  finance: 'finance_analyst',
};

export const ReadinessCheckSchema = z.object({ code: z.string(), passed: z.boolean(), detail: z.string() });

export const ReadinessSchema = z.object({
  states: z.array(z.string()),
  asOf: z.string(),
  ready: z.boolean(),
  /** Changes whenever anything the report says changes; a sign-off belongs to one value of it. */
  reportHash: z.string(),
  byState: z.array(
    z.object({
      state: z.string(),
      ready: z.boolean(),
      checks: z.array(ReadinessCheckSchema),
      plans: z.array(z.object({ code: z.string(), name: z.string(), version: z.number().int(), ready: z.boolean(), checks: z.array(ReadinessCheckSchema) })),
    }),
  ),
  signoffs: z.array(
    z.object({
      area: z.enum(SIGNOFF_AREAS),
      signed: z.boolean(),
      by: z.string().nullable(),
      name: z.string().nullable(),
      at: z.iso.datetime().nullable(),
      note: z.string().nullable(),
    }),
  ),
  /** Every state ready and all four areas signed, by four different people, for this report. */
  goLiveApproved: z.boolean(),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

export const SignoffRequestSchema = z.object({
  states: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(60),
  area: z.enum(SIGNOFF_AREAS),
  decision: z.enum(['signed', 'withdrawn']),
  /** The hash of the report the person read; refused if the report has changed since. */
  reportHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().trim().min(3).max(2000),
});
