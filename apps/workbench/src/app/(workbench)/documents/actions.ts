'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { IssuedDocument, Proposal, Template } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

/** Assembles a plan version's schedule or policy from its filed form. */
export async function createTemplate(_prev: ActionState, form: FormData): Promise<ActionState> {
  let created: Template;
  try {
    created = await api<Template>('/v1/document-templates', { method: 'POST', body: { planVersionId: text(form, 'planVersionId'), kind: text(form, 'kind') }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/documents');
  redirect(`/documents/templates/${created.id}`);
}

/** Releases a template: the API checks it again, refuses the person who made it, and refuses while a finding holds it. */
export async function releaseTemplate(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'templateId');
  try {
    await api<Template>(`/v1/document-templates/${encodeURIComponent(id)}/release`, { method: 'POST', body: { note: text(form, 'note') || undefined }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/documents/templates/${id}`);
  redirect(`/documents/templates/${id}?released=1`);
}

export async function retryDelivery(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api<IssuedDocument>(`/v1/document-deliveries/${encodeURIComponent(text(form, 'deliveryId'))}/retry`, { method: 'POST', body: {}, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/documents/failures');
  return { status: 'success', message: 'Queued to send again.' };
}

/** Issues the purchase confirmation, schedule and policy that a policy is missing. */
export async function issueMissing(_prev: ActionState, form: FormData): Promise<ActionState> {
  const policyId = text(form, 'policyId');
  try {
    const out = await api<{ items: IssuedDocument[] }>(`/v1/policies/${encodeURIComponent(policyId)}/documents/issue`, { method: 'POST', body: {}, idempotencyKey: randomUUID() });
    revalidatePath(`/policies/${policyId}`);
    revalidatePath('/documents/failures');
    const failed = out.items.filter((d) => d.status === 'failed');
    return failed.length
      ? { status: 'error', message: `Not issued: ${failed.map((d) => `${d.kind.replace(/_/g, ' ')}: ${d.failure}`).join(' ')}`, fieldErrors: {}, values: {} }
      : { status: 'success', message: 'The documents are issued.' };
  } catch (err) {
    return fromError(err, form);
  }
}

/** Records what a person decided about the Document Quality agent's findings: accepted ones show a defect. */
export async function reviewFindings(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'proposalId');
  const all = JSON.parse(text(form, 'items') || '[]') as string[];
  const accepted = form.getAll('accept').filter((v): v is string => typeof v === 'string');
  try {
    await api<Proposal>(`/v1/agent-proposals/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: { accepted, rejected: all.filter((x) => !accepted.includes(x)), note: text(form, 'note') || undefined },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/proposals/${id}`);
  redirect(`/proposals/${id}?done=reviewed`);
}
