import { z } from 'zod';

/**
 * Error model for every Astra API (RFC 9457 problem details, extended with a stable `code`,
 * field-level `errors` and the request `correlationId`). Satisfies E04-F01-S03: each error has a code,
 * a message and, where relevant, a field.
 */
export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'precondition_failed',
  'idempotency_key_required',
  'idempotency_key_reused',
  'idempotency_in_progress',
  'rate_limited',
  'payload_too_large',
  'service_unavailable',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const FieldErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string(),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(ERROR_CODES),
  detail: z.string().optional(),
  errors: z.array(FieldErrorSchema).optional(),
  correlationId: z.string(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  idempotency_key_required: 428,
  idempotency_key_reused: 422,
  idempotency_in_progress: 409,
  rate_limited: 429,
  payload_too_large: 413,
  service_unavailable: 503,
  internal_error: 500,
};

export const ERROR_TITLES: Record<ErrorCode, string> = {
  validation_failed: 'The request is not valid',
  unauthenticated: 'Authentication is required',
  forbidden: 'You do not have permission for this action',
  not_found: 'The resource was not found',
  conflict: 'The request conflicts with the current state',
  precondition_failed: 'A precondition for this request was not met',
  idempotency_key_required: 'An Idempotency-Key header is required',
  idempotency_key_reused: 'The Idempotency-Key was already used with a different request',
  idempotency_in_progress: 'A request with this Idempotency-Key is still being processed',
  rate_limited: 'Too many requests',
  payload_too_large: 'The request body is too large',
  service_unavailable: 'The service is temporarily unavailable',
  internal_error: 'An unexpected error occurred',
};

export function problemType(code: ErrorCode): string {
  return `urn:astra:error:${code}`;
}
