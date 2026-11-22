import { z } from 'zod';

/**
 * Reference datasets (E16-F01-S02). Each is defined here with its key and entry schema; its content is
 * loaded as versions with effective dates and approved by a second person. Datasets whose content comes
 * from filed manuals or from Assurant carry `awaiting` until a version is approved.
 */

const date = z.iso.date();
const STATE = z.string().regex(/^[A-Z]{2}$/, 'Two-letter code');
const COUNTRY = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code');

export const REFDATA_DATASETS = {
  us_states: {
    name: 'US states, district and territories',
    description: 'Two-letter codes for states, the District of Columbia and US territories.',
    keyField: 'code',
    expectedSource: 'USPS Publication 28, Appendix B',
    entry: z.object({
      code: STATE,
      name: z.string().min(2).max(60),
      kind: z.enum(['state', 'district', 'territory']),
    }),
  },
  countries: {
    name: 'Countries',
    description:
      'ISO 3166-1 country codes and English short names, used for destinations and screening.',
    keyField: 'code',
    expectedSource: 'ISO 3166-1',
    entry: z.object({
      code: COUNTRY,
      alpha3: z.string().regex(/^[A-Z]{3}$/),
      numeric: z.string().regex(/^\d{3}$/),
      name: z.string().min(2).max(100),
    }),
  },
  destination_regions: {
    name: 'Destination regions',
    description:
      'Rating regions (for example Europe, Caribbean, Antarctica) and the countries in each, as filed in the rate manuals.',
    keyField: 'code',
    expectedSource: 'Filed rate manuals (for example Delaware TC manual, table 2.1.9)',
    entry: z.object({
      code: z.string().regex(/^[A-Z0-9_]{2,32}$/),
      name: z.string().min(2).max(100),
      scope: z.enum(['domestic', 'international']),
      countries: z.array(COUNTRY).min(1),
    }),
  },
  business_segments: {
    name: 'Business segments',
    description:
      'The filed list of account business segments (about 42). Segment factors live in the rate manuals.',
    keyField: 'code',
    expectedSource: 'Filed rate manuals (business segment table)',
    entry: z.object({
      code: z.string().regex(/^[A-Z0-9_]{2,40}$/),
      name: z.string().min(2).max(100),
      description: z.string().max(500).optional(),
    }),
  },
  prohibited_destinations: {
    name: 'Prohibited destinations',
    description:
      'Countries for which cover is not offered. Filled into the policy form placeholder and checked at quote and bind.',
    keyField: 'country',
    expectedSource: 'Assurant compliance (sanctions and filed exclusions)',
    entry: z.object({
      country: COUNTRY,
      reason: z.string().min(3).max(300),
    }),
  },
  premium_tax_rates: {
    name: 'Premium tax rates',
    description: 'Premium tax and fee rates by state and insurer.',
    keyField: 'key',
    expectedSource: 'State premium tax schedules, confirmed by Assurant tax',
    entry: z
      .object({
        key: z.string().regex(/^[A-Z]{2}:(VSC|ABIC)$/),
        state: STATE,
        insurer: z.enum(['VSC', 'ABIC']),
        ratePercent: z.number().min(0).max(20),
        basis: z.string().min(2).max(200),
        notes: z.string().max(500).optional(),
      })
      .refine((v) => v.key === `${v.state}:${v.insurer}`, {
        message: 'key must be STATE:INSURER',
        path: ['key'],
      }),
  },
} as const;

export type RefdataDataset = keyof typeof REFDATA_DATASETS;
export const REFDATA_DATASET_CODES = Object.keys(REFDATA_DATASETS) as RefdataDataset[];

/** Datasets whose entries refer to countries: their codes must exist in the countries version in force. */
export const COUNTRY_REFERENCES: Partial<
  Record<RefdataDataset, (entry: Record<string, unknown>) => string[]>
> = {
  destination_regions: (e) => (e.countries as string[]) ?? [],
  prohibited_destinations: (e) => [e.country as string],
};
export const STATE_REFERENCES: Partial<
  Record<RefdataDataset, (entry: Record<string, unknown>) => string[]>
> = {
  premium_tax_rates: (e) => [e.state as string],
};

export const REFDATA_VERSION_STATUSES = ['draft', 'approved', 'rejected'] as const;

export const RefdataVersionSchema = z.object({
  id: z.uuid(),
  dataset: z.string(),
  version: z.number().int(),
  status: z.enum(REFDATA_VERSION_STATUSES),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  source: z.string(),
  notes: z.string().nullable(),
  entryCount: z.number().int(),
  sha256: z.string(),
  loadedBy: z.string(),
  loadedAt: z.iso.datetime({ offset: true }),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  decisionReason: z.string().nullable(),
});
export type RefdataVersion = z.infer<typeof RefdataVersionSchema>;

export const RefdataDatasetSummarySchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  expectedSource: z.string(),
  keyField: z.string(),
  fields: z.array(z.string()),
  inForce: RefdataVersionSchema.nullable(),
  pending: z.number().int(),
});
export type RefdataDatasetSummary = z.infer<typeof RefdataDatasetSummarySchema>;

export const LoadRefdataRequestSchema = z.object({
  effectiveFrom: date,
  source: z.string().trim().min(3).max(500),
  notes: z.string().trim().max(1000).optional(),
  entries: z.array(z.record(z.string(), z.unknown())).min(1).max(100_000),
});

export const DecideRefdataRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(5).max(500),
});

export const RefdataEntrySchema = z.object({
  key: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export const RefdataDiffSchema = z.object({
  against: z.object({ id: z.uuid(), version: z.number().int() }).nullable(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  unchanged: z.number().int(),
});
export type RefdataDiff = z.infer<typeof RefdataDiffSchema>;
