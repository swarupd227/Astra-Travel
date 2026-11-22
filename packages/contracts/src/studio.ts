import { z } from 'zod';
import { FilingSchema, INSURERS } from './compliance';

/** Form library and variable maps (E01-F01-S01, E01-F01-S02). */

export const FORM_KINDS = [
  'policy',
  'schedule',
  'certificate',
  'endorsement',
  'application',
] as const;

export const VARIABLE_TYPES = [
  'optional_benefit',
  'numeric_range',
  'percentage_range',
  'wording_choice',
  'time_period',
  'limit_basis',
  'insert_placeholder',
] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const VARIABLE_TYPE_LABELS: Record<VariableType, string> = {
  optional_benefit: 'Optional benefit',
  numeric_range: 'Numeric range',
  percentage_range: 'Percentage range',
  wording_choice: 'Choice of wording',
  time_period: 'Time period',
  limit_basis: 'Limit basis',
  insert_placeholder: 'Insert placeholder',
};

const ordered = (v: { min: number; max: number }) => v.max >= v.min;
const orderedMessage = { message: 'The maximum must not be below the minimum', path: ['max'] };

const options = z.array(z.string().trim().min(1).max(300)).min(2).max(50);

/** The filed range or options of each variable type. */
export const VariableConstraintsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('optional_benefit'), constraints: z.object({}).strict() }),
  z.object({
    type: z.literal('numeric_range'),
    constraints: z
      .object({ min: z.number(), max: z.number(), unit: z.enum(['usd', 'number']) })
      .refine(ordered, orderedMessage),
  }),
  z.object({
    type: z.literal('percentage_range'),
    constraints: z
      .object({
        min: z.number(),
        max: z.number(),
        bases: z.array(z.string().trim().min(1).max(100)).max(10),
      })
      .refine(ordered, orderedMessage)
      .refine((v) => v.min >= 0 && v.max <= 1000, {
        message: 'Percentages are between 0 and 1000',
        path: ['max'],
      }),
  }),
  z.object({
    type: z.literal('wording_choice'),
    constraints: z.object({ options, multiple: z.boolean() }),
  }),
  z.object({
    type: z.literal('time_period'),
    constraints: z
      .object({
        min: z.number(),
        max: z.number(),
        unit: z.enum(['hours', 'days', 'months', 'years']),
      })
      .refine(ordered, orderedMessage),
  }),
  z.object({ type: z.literal('limit_basis'), constraints: z.object({ options }) }),
  z.object({
    type: z.literal('insert_placeholder'),
    constraints: z
      .object({ source: z.enum(['dataset', 'url', 'text']), dataset: z.string().optional() })
      .refine((v) => v.source !== 'dataset' || !!v.dataset, {
        message: 'Choose the reference dataset',
        path: ['dataset'],
      }),
  }),
]);
export type VariableConstraints = z.infer<typeof VariableConstraintsSchema>;

export const FormVariableInputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,63}$/, 'Lower-case letters, digits and _, starting with a letter'),
    label: z.string().trim().min(2).max(200),
    textStart: z.number().int().min(0),
    textEnd: z.number().int().min(1),
    excerpt: z.string().min(1),
    notes: z.string().trim().max(1000).optional(),
  })
  .and(VariableConstraintsSchema)
  .refine((v) => v.textEnd > v.textStart, {
    message: 'The end must be after the start',
    path: ['textEnd'],
  });
export type FormVariableInput = z.infer<typeof FormVariableInputSchema>;

export const FormVariableSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(VARIABLE_TYPES),
  constraints: z.record(z.string(), z.unknown()),
  textStart: z.number().int(),
  textEnd: z.number().int(),
  page: z.number().int(),
  excerpt: z.string(),
  notes: z.string().nullable(),
});
export type FormVariable = z.infer<typeof FormVariableSchema>;

export const VariableMapSchema = z.object({
  id: z.uuid(),
  editionId: z.uuid(),
  version: z.number().int(),
  status: z.enum(['draft', 'approved', 'superseded']),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
  approvalNote: z.string().nullable(),
  /** Everyone who created or edited the draft; none of them may approve it. */
  contributors: z.array(z.string()),
  variables: z.array(FormVariableSchema),
});
export type VariableMap = z.infer<typeof VariableMapSchema>;

export const FormEditionSchema = z.object({
  id: z.uuid(),
  formNumber: z.string(),
  edition: z.string(),
  title: z.string(),
  kind: z.enum(FORM_KINDS),
  insurer: z.enum(INSURERS),
  fileName: z.string(),
  contentType: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  pageCount: z.number().int(),
  textLength: z.number().int(),
  createdBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Per-state filing status for this edition. */
  filings: z.array(FilingSchema),
  currentMap: z
    .object({ id: z.uuid(), version: z.number().int(), variables: z.number().int() })
    .nullable(),
  draftMap: z
    .object({ id: z.uuid(), version: z.number().int(), variables: z.number().int() })
    .nullable(),
});
export type FormEdition = z.infer<typeof FormEditionSchema>;

export const FormTextSchema = z.object({
  text: z.string(),
  pageStarts: z.array(z.number().int()),
});

export const CreateFormEditionQuerySchema = z.object({
  formNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,59}$/, 'Letters, digits, _ . -'),
  edition: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Edition as YYYY-MM'),
  title: z.string().trim().min(2).max(200),
  kind: z.enum(FORM_KINDS),
  insurer: z.enum(INSURERS),
  fileName: z.string().trim().min(1).max(200),
});

export const BracketSpanSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
  text: z.string(),
  depth: z.number().int(),
  page: z.number().int(),
  mapped: z.boolean(),
  suggestion: z
    .object({
      type: z.enum(VARIABLE_TYPES),
      constraints: z.record(z.string(), z.unknown()),
      why: z.string(),
    })
    .nullable(),
});
export type BracketSpan = z.infer<typeof BracketSpanSchema>;

export const ApproveMapRequestSchema = z.object({ note: z.string().trim().min(5).max(500) });

export const UsabilityAnswerSchema = z.object({
  usable: z.boolean(),
  reason: z.string(),
  filing: FilingSchema.nullable(),
});
