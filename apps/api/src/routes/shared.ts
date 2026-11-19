import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { ProblemSchema } from '@astra/contracts';

export const idempotencyHeaders = z.object({
  'idempotency-key': z.string().optional(),
});

export function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return Array.isArray(value) ? value[0] : value;
}

/** Problem responses most routes can return. */
export const commonErrors = {
  400: ProblemSchema,
  401: ProblemSchema,
  403: ProblemSchema,
  404: ProblemSchema,
  409: ProblemSchema,
  422: ProblemSchema,
  428: ProblemSchema,
} as const;

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const uuidParam = (name: string) => z.object({ [name]: z.uuid() });
