import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import {
  ERROR_STATUS,
  ERROR_TITLES,
  problemType,
  type ErrorCode,
  type FieldError,
  type Problem,
} from '@astra/contracts';
import { AppError } from '@astra/platform';

export function problem(
  code: ErrorCode,
  correlationId: string,
  detail?: string,
  errors?: FieldError[],
): Problem {
  return {
    type: problemType(code),
    title: ERROR_TITLES[code],
    status: ERROR_STATUS[code],
    code,
    ...(detail ? { detail } : {}),
    ...(errors?.length ? { errors } : {}),
    correlationId,
  };
}

export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type('application/problem+json').send(p);
}

function fieldPath(context: string | undefined, instancePath: string): string {
  const path = instancePath.replace(/^\//, '').replace(/\//g, '.');
  const prefix = context === 'body' || !context ? '' : `${context}.`;
  return `${prefix}${path}` || context || 'body';
}

export function errorHandler(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const correlationId = String(request.id);

  if (hasZodFastifySchemaValidationErrors(err)) {
    const errors: FieldError[] = err.validation.map((v) => ({
      code: String((v.params as { issue?: { code?: string } })?.issue?.code ?? 'invalid'),
      message: v.message ?? 'Invalid value',
      field: fieldPath(err.validationContext, v.instancePath),
    }));
    return sendProblem(reply, problem('validation_failed', correlationId, undefined, errors));
  }

  if (err instanceof AppError) {
    if (err.status >= 500) request.log.error({ err }, err.message);
    return sendProblem(reply, problem(err.code, correlationId, err.detail, err.errors));
  }

  if (isResponseSerializationError(err)) {
    request.log.error({ err, issues: err.cause?.issues }, 'Response did not match its schema');
    return sendProblem(reply, problem('internal_error', correlationId));
  }

  const status = err.statusCode ?? 500;
  if (status === 429)
    return sendProblem(reply, problem('rate_limited', correlationId, err.message));
  if (status === 413) return sendProblem(reply, problem('payload_too_large', correlationId));
  if (status === 404) return sendProblem(reply, problem('not_found', correlationId));
  if (status >= 400 && status < 500) {
    return sendProblem(reply, problem('validation_failed', correlationId, err.message));
  }

  request.log.error({ err }, 'Unhandled error');
  return sendProblem(reply, problem('internal_error', correlationId));
}
