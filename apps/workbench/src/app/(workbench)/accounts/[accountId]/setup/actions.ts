'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { INTEGRATION_METHODS, RATING_INPUTS } from '@astra/contracts';
import { api, apiUpload } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export type CredentialState = ActionState & { secret?: { clientId: string; clientSecret: string; tokenUrl: string } };

const back = (id: string) => revalidatePath(`/accounts/${id}/setup`);
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.toUpperCase()).filter(Boolean);

export async function saveProfile(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  const method = text(form, 'integrationMethod');
  const basis = text(form, 'basis');
  const body = {
    contractReference: text(form, 'contractReference') || null,
    contractSignedOn: text(form, 'contractSignedOn') || null,
    states: list(text(form, 'states')),
    plans: list(text(form, 'plans')),
    integrationMethod: (INTEGRATION_METHODS as readonly string[]).includes(method) ? method : null,
    rateBasis: basis ? { basis, ...(text(form, 'limit') ? { limit: text(form, 'limit') } : {}), ...(text(form, 'fixedFeePerPolicy') ? { fixedFeePerPolicy: text(form, 'fixedFeePerPolicy') } : {}) } : null,
    settlement: text(form, 'settlement') ? { description: text(form, 'settlement'), paymentDays: text(form, 'paymentDays') ? Number(text(form, 'paymentDays')) : null } : null,
  };
  try {
    await api(`/v1/accounts/${id}/profile`, { method: 'PUT', body, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  back(id);
  return { status: 'success', message: 'The profile is saved. The checklist shows what is still open.' };
}

export async function requestSegment(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  try {
    await api(`/v1/accounts/${id}/segment-changes`, { method: 'POST', body: { segment: text(form, 'segment'), effectiveFrom: text(form, 'effectiveFrom'), reason: text(form, 'reason') }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  back(id);
  return { status: 'success', message: 'Requested. An underwriter approves it before it applies.' };
}

export async function decideSegment(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api(`/v1/segment-changes/${encodeURIComponent(text(form, 'changeId'))}/decision`, { method: 'POST', body: { decision: text(form, 'decision'), note: text(form, 'note') || 'Reviewed' }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  back(text(form, 'accountId'));
  return { status: 'success', message: 'Recorded.' };
}

export async function saveCollected(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  const notCollected = form.getAll('notCollected').filter((v): v is string => typeof v === 'string' && (RATING_INPUTS as readonly string[]).includes(v));
  try {
    await api(`/v1/accounts/${id}/collected-variables`, { method: 'PUT', body: { notCollected, reason: text(form, 'reason') }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  back(id);
  return { status: 'success', message: 'Recorded. Quotes use it at once.' };
}

export async function addLicence(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  try {
    await api(`/v1/accounts/${id}/licences`, { method: 'POST', body: { kind: text(form, 'kind'), state: text(form, 'state').toUpperCase(), number: text(form, 'number'), holder: text(form, 'holder'), validFrom: text(form, 'validFrom'), expiresOn: text(form, 'expiresOn') }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  back(id);
  revalidatePath('/compliance/licences');
  return { status: 'success', message: 'Recorded.' };
}

export async function revokeLicence(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api(`/v1/licences/${encodeURIComponent(text(form, 'licenceId'))}/revoke`, { method: 'POST', body: { reason: text(form, 'reason') || 'Revoked' }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  if (text(form, 'accountId')) back(text(form, 'accountId'));
  revalidatePath('/compliance/licences');
  return { status: 'success', message: 'Revoked.' };
}

export async function uploadContract(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return { status: 'error', message: 'Choose a PDF or text file.', fieldErrors: {}, values: {} };
  try {
    await apiUpload(`/v1/accounts/${id}/documents`, file, { kind: text(form, 'kind'), fileName: file.name }, file.type === 'application/pdf' ? 'application/pdf' : 'text/plain');
  } catch (err) {
    return fromError(err, form);
  }
  back(id);
  return { status: 'success', message: 'Uploaded. The Account Onboarding agent can read it now.' };
}

export async function createSandbox(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  try {
    await api(`/v1/accounts/${id}/sandbox`, { method: 'POST', body: {}, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  back(id);
  return { status: 'success', message: 'The sandbox is ready.' };
}

export async function issueCredentials(_prev: CredentialState, form: FormData): Promise<CredentialState> {
  const id = text(form, 'accountId');
  try {
    const out = await api<{ clientId: string; clientSecret: string; tokenUrl: string; note: string }>(`/v1/accounts/${id}/sandbox/credentials`, { method: 'POST', body: {}, idempotencyKey: randomUUID() });
    back(id);
    return { status: 'success', message: out.note, secret: { clientId: out.clientId, clientSecret: out.clientSecret, tokenUrl: out.tokenUrl } };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function revokeCredentials(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  try {
    await api(`/v1/accounts/${id}/sandbox/credentials/${encodeURIComponent(text(form, 'clientId'))}/revoke`, { method: 'POST', body: {}, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  back(id);
  return { status: 'success', message: 'Revoked.' };
}

export async function goLive(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'accountId');
  try {
    await api(`/v1/accounts/${id}/go-live`, { method: 'POST', body: { note: text(form, 'note') }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  back(id);
  redirect(`/accounts/${id}/setup?live=1`);
}
