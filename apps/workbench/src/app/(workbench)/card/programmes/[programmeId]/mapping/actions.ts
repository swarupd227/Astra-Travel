'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { AgentRun, FeedMapping, FeedSample } from '@astra/contracts';
import { api, apiUpload } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const uuid = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : 'invalid');
const failed = (message: string): ActionState => ({ status: 'error', message, fieldErrors: {}, values: {} });

export async function sendSample(_prev: ActionState, form: FormData): Promise<ActionState> {
  const programmeId = uuid(text(form, 'programmeId'));
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return failed('Choose the issuer’s file.');
  try {
    const { body } = await apiUpload<FeedSample>(`/v1/card-programmes/${programmeId}/samples`, file.slice(0, 4 * 1024 * 1024), { fileName: file.name }, 'text/plain');
    revalidatePath(`/card/programmes/${programmeId}/mapping`);
    return { status: 'success', message: `Kept ${body.lines} lines.${body.cardNumbersRemoved ? ` ${body.cardNumbersRemoved} card number(s) were removed before storing.` : ''}` };
  } catch (err) {
    return fromError(err, form);
  }
}

/** Asks AG-09 to draft a mapping or explain a feed's rejections. It acts with at most the person's own access. */
export async function askFeedAgent(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api<AgentRun>('/v1/agents/AG-09/runs', { method: 'POST', body: { question: text(form, 'question') }, idempotencyKey: randomUUID() });
    return { status: 'success', message: 'Asked. Reload in a moment to see the agent’s proposal.' };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function approveMapping(_prev: ActionState, form: FormData): Promise<ActionState> {
  const programmeId = uuid(text(form, 'programmeId'));
  let document: unknown;
  try {
    document = JSON.parse(text(form, 'document'));
  } catch {
    return { ...failed('The mapping is not valid JSON.'), values: { document: [text(form, 'document')] } } as ActionState;
  }
  const proposalId = text(form, 'proposalId');
  try {
    const m = await api<FeedMapping>(`/v1/card-programmes/${programmeId}/mappings`, { method: 'POST', body: { document, sampleId: text(form, 'sampleId'), ...(proposalId ? { proposalId } : {}) } });
    revalidatePath(`/card/programmes/${programmeId}/mapping`);
    return { status: 'success', message: `Approved as version ${m.version}. The issuer’s files are now read with it.` };
  } catch (err) {
    return fromError(err, form);
  }
}

export async function decideExplanations(_prev: ActionState, form: FormData): Promise<ActionState> {
  const programmeId = uuid(text(form, 'programmeId'));
  const proposalId = uuid(text(form, 'proposalId'));
  const decisions = [...form.entries()].filter(([k]) => k.startsWith('decision:')).map(([k, v]) => ({ code: k.slice('decision:'.length), decision: String(v) }));
  try {
    const r = await api<{ approved: string[]; mapping: FeedMapping | null }>(`/v1/card-programmes/${programmeId}/explanations/${proposalId}/decision`, { method: 'POST', body: { decisions, ...(text(form, 'note') ? { note: text(form, 'note') } : {}) } });
    revalidatePath(`/card/programmes/${programmeId}`);
    return { status: 'success', message: `Recorded: ${r.approved.length} fix(es) approved.${r.mapping ? ` Mapping version ${r.mapping.version} is now in use.` : ''}` };
  } catch (err) {
    return fromError(err, form);
  }
}
