'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Batch, CommissionRule, PremiumRecord } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** Reads "limit: percent" lines (tiers) or "policies: percent" lines (volume bands) the person typed. */
function pairs(s: string): [number | null, number][] {
  return lines(s).map((l) => {
    const [a, b] = l.split(':').map((x) => x.trim());
    return [a === '' || a === undefined || /^(no limit|rest|\*)$/i.test(a) ? null : Number(a), Number(b)];
  });
}

export async function createCommissionRule(_prev: ActionState, form: FormData): Promise<ActionState> {
  const kind = text(form, 'kind');
  const percent = Number(text(form, 'percent'));
  const document =
    kind === 'none'
      ? { kind }
      : kind === 'flat'
        ? { kind, percent }
        : kind === 'tiered'
          ? { kind, tiers: pairs(text(form, 'tiers')).map(([upTo, p]) => ({ upTo, percent: p })) }
          : { kind: 'volume', bands: pairs(text(form, 'bands')).map(([min, p]) => ({ minPolicies: min ?? 0, percent: p })) };
  try {
    await api<CommissionRule>('/v1/commission-rules', { method: 'POST', body: { accountId: text(form, 'accountId'), effectiveFrom: text(form, 'effectiveFrom'), document }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/billing/rules');
  return { status: 'success', message: 'The rule is proposed. Someone else approves it before it applies.' };
}

export async function approveRule(_prev: ActionState, form: FormData): Promise<ActionState> {
  const path = text(form, 'programme') === '1' ? 'programme-premium-rules' : 'commission-rules';
  try {
    await api(`/v1/${path}/${encodeURIComponent(text(form, 'ruleId'))}/approve`, { method: 'POST', body: {}, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/billing/rules');
  return { status: 'success', message: 'Approved.' };
}

export async function createProgrammeRule(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api('/v1/programme-premium-rules', { method: 'POST', body: { programmeId: text(form, 'programmeId'), effectiveFrom: text(form, 'effectiveFrom'), rate: text(form, 'rate') }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/billing/rules');
  return { status: 'success', message: 'The rate is proposed. Someone else approves it before it applies.' };
}

export async function createProgrammePremium(_prev: ActionState, form: FormData): Promise<ActionState> {
  let rec: PremiumRecord;
  try {
    rec = await api<PremiumRecord>('/v1/programme-premium', { method: 'POST', body: { programmeId: text(form, 'programmeId'), month: text(form, 'month') }, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/billing');
  redirect(`/billing/records/${rec.id}`);
}

export async function createBatch(_prev: ActionState, _form: FormData): Promise<ActionState> {
  let out: { id?: string; totals?: { count: number } } & { batch?: null; message?: string };
  try {
    out = await api('/v1/billing/batches', { method: 'POST', body: {}, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, _form);
  }
  revalidatePath('/billing/batches');
  if (!out.id) return { status: 'success', message: out.message ?? 'Nothing is ready to send.' };
  return { status: 'success', message: `Batch made with ${out.totals?.count ?? 0} records. The worker sends it.` };
}

export async function retryBatch(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api<Batch>(`/v1/billing/batches/${encodeURIComponent(text(form, 'batchId'))}/retry`, { method: 'POST', body: {}, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/billing/batches');
  return { status: 'success', message: 'Queued to be sent again.' };
}

export async function recalculateRecord(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'recordId');
  try {
    await api<PremiumRecord>(`/v1/premium-records/${encodeURIComponent(id)}/recalculate`, { method: 'POST', body: {}, idempotencyKey: randomUUID() });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/billing/records/${id}`);
  redirect(`/billing/records/${id}?recalculated=1`);
}
