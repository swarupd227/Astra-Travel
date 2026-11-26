import type { FastifyRequest } from 'fastify';
import { AppError } from '@astra/platform';

/**
 * Who in Salesforce Service Cloud asked for an action, and for which case (E14-F02-S02). Sent as two headers on the
 * servicing and document actions; both or neither. The person still acts with their own platform sign-in and role:
 * these only record the Service Cloud side of it.
 */
export const SERVICE_CLOUD_USER_HEADER = 'x-service-cloud-user';
export const SERVICE_CLOUD_CASE_HEADER = 'x-service-cloud-case';

export interface ExternalCase {
  system: 'service_cloud';
  userId: string;
  caseReference: string;
}

const VALID = /^[A-Za-z0-9._@:/-]{1,100}$/;

export function externalCaseOf(request: FastifyRequest): ExternalCase | null {
  const user = request.headers[SERVICE_CLOUD_USER_HEADER];
  const ref = request.headers[SERVICE_CLOUD_CASE_HEADER];
  if (user === undefined && ref === undefined) return null;
  const bad = (field: string, message: string) => new AppError('validation_failed', message, [{ code: 'service_cloud', field, message }]);
  if (typeof user !== 'string' || !VALID.test(user)) throw bad(SERVICE_CLOUD_USER_HEADER, 'Give the Service Cloud user (up to 100 letters, digits or . _ @ : / -) with the case reference.');
  if (typeof ref !== 'string' || !VALID.test(ref)) throw bad(SERVICE_CLOUD_CASE_HEADER, 'Give the Service Cloud case reference (up to 100 letters, digits or . _ @ : / -) with the user.');
  return { system: 'service_cloud', userId: user, caseReference: ref };
}
