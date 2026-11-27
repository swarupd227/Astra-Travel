import { z } from 'zod';

/**
 * The connection to the language model the agents use (E15-F02-S02): the API key a platform administrator
 * saves, and the result of testing it. The key itself is never returned once saved.
 */

const reason = z.string().trim().min(3).max(500);

const apiKey = z
  .string()
  .trim()
  .min(20, 'This is too short to be an API key.')
  .max(500)
  .regex(/^[\x21-\x7e]+$/, 'An API key has no spaces or special characters.');

export const SaveModelKeyRequestSchema = z.object({ apiKey, reason });
export type SaveModelKeyRequest = z.infer<typeof SaveModelKeyRequestSchema>;

export const RemoveModelKeyRequestSchema = z.object({ reason });

/** Without `apiKey` the saved key is tested. */
export const TestModelConnectionRequestSchema = z.object({ apiKey: apiKey.optional() });

export const MODEL_TEST_OUTCOMES = [
  'connected',
  'invalid_key',
  'no_access',
  'model_unavailable',
  'rate_limited',
  'rejected',
  'unreachable',
  'service_error',
] as const;
export type ModelTestOutcome = (typeof MODEL_TEST_OUTCOMES)[number];

export const ModelConnectionTestSchema = z.object({
  ok: z.boolean(),
  /** `entered`: a key typed for the test and not saved. */
  source: z.enum(['entered', 'saved']),
  outcome: z.enum(MODEL_TEST_OUTCOMES),
  message: z.string(),
  models: z.array(z.object({ model: z.string(), ok: z.boolean() })),
  latencyMs: z.number().int(),
  testedAt: z.iso.datetime(),
});
export type ModelConnectionTest = z.infer<typeof ModelConnectionTestSchema>;

export const ModelConnectionSchema = z.object({
  provider: z.literal('anthropic'),
  /** The saved key, identified only by its last four characters; null when none is saved. */
  savedKey: z
    .object({
      endsWith: z.string(),
      savedAt: z.iso.datetime(),
      savedBy: z.string(),
      reason: z.string(),
    })
    .nullable(),
  /** The models the agents in this build call; the test calls each one. */
  models: z.array(z.string()),
  /** The latest test of the saved key; null when it has not been tested since it was saved. */
  lastTest: ModelConnectionTestSchema.extend({ testedBy: z.string() }).nullable(),
});
export type ModelConnection = z.infer<typeof ModelConnectionSchema>;
