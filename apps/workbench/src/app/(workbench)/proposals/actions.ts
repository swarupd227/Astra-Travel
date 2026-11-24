'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { AgentRun, FormVariableInput, Proposal, RateManual, VariableMap } from '@astra/contracts';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

export type AskState = ActionState & { runId?: string };

/** A person asks an agent to prepare a proposal. The agent acts with at most the person's own permissions. */
export async function askAgent(_prev: AskState, form: FormData): Promise<AskState> {
  const agentId = text(form, 'agentId');
  try {
    const run = await api<AgentRun>(`/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'POST',
      body: { question: text(form, 'question') },
      idempotencyKey: randomUUID(),
    });
    return { status: 'success', message: 'Asked. The agent is working; its proposal appears here when it is ready.', runId: run.id };
  } catch (err) {
    return fromError(err, form);
  }
}

async function resolve(id: string, body: Record<string, unknown>) {
  await api<Proposal>(`/v1/agent-proposals/${encodeURIComponent(id)}/resolve`, { method: 'POST', body });
}

/** Rejects or acknowledges everything in a proposal without applying anything. */
export async function closeProposal(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'proposalId');
  const items = JSON.parse(text(form, 'items') || '[]') as string[];
  const reviewed = text(form, 'mode') === 'reviewed';
  try {
    await resolve(id, { accepted: reviewed ? items : [], rejected: reviewed ? [] : items, note: text(form, 'note') || undefined });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/proposals/${id}`);
  redirect(`/proposals/${id}?done=${reviewed ? 'reviewed' : 'rejected'}`);
}

interface Picked {
  key: string;
  original: FormVariableInput;
  corrected: { key: string; label: string; min?: number; max?: number };
}

/**
 * Saves the variables a person accepted into the edition's draft variable map, with their corrections, through
 * the ordinary API (so the same checks and maker-checker apply), then records what was accepted, corrected
 * and rejected.
 */
export async function applyVariableMap(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'proposalId');
  const editionId = text(form, 'editionId');
  const picked = JSON.parse(text(form, 'picked') || '[]') as Picked[];
  const all = JSON.parse(text(form, 'items') || '[]') as string[];
  if (picked.length === 0) {
    return { status: 'error', message: 'Choose at least one variable to save, or reject the proposal.', fieldErrors: {}, values: {} };
  }
  let mapId: string;
  try {
    const maps = await api<{ items: { id: string; status: string }[] }>(`/v1/form-editions/${editionId}/maps`);
    const draft = maps.items.find((m) => m.status === 'draft');
    mapId = draft ? draft.id : (await api<VariableMap>(`/v1/form-editions/${editionId}/maps`, { method: 'POST', idempotencyKey: randomUUID() })).id;
  } catch (err) {
    return fromError(err, form);
  }
  const corrected: string[] = [];
  const accepted: string[] = [];
  for (const p of picked) {
    const v: FormVariableInput = JSON.parse(JSON.stringify(p.original));
    v.key = p.corrected.key;
    v.label = p.corrected.label;
    if (p.corrected.min !== undefined && 'constraints' in v && v.constraints && 'min' in v.constraints) (v.constraints as { min: number }).min = p.corrected.min;
    if (p.corrected.max !== undefined && 'constraints' in v && v.constraints && 'max' in v.constraints) (v.constraints as { max: number }).max = p.corrected.max;
    try {
      await api(`/v1/variable-maps/${mapId}/variables/${encodeURIComponent(v.key)}`, { method: 'PUT', body: v });
    } catch (err) {
      const e = fromError(err, form);
      return e.status === 'error' ? { ...e, message: `${p.original.label || p.key} was not saved: ${e.message} Variables before it were saved to the draft map; accept the rest again after fixing this one.` } : e;
    }
    (JSON.stringify(v) === JSON.stringify(p.original) ? accepted : corrected).push(p.key);
  }
  const savedKeys = new Set(picked.map((p) => p.key));
  try {
    await resolve(id, { accepted, corrected, rejected: all.filter((k) => !savedKeys.has(k)), appliedTo: { type: 'variable_map', id: mapId } });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/proposals/${id}`);
  redirect(`/proposals/${id}?done=applied&map=${mapId}`);
}

/** Loads the drafted manual as a draft rate manual; a second analyst approves it and parity gates publication. */
export async function loadDraftManual(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'proposalId');
  let manual: unknown;
  try {
    manual = JSON.parse(text(form, 'manual'));
  } catch {
    return { status: 'error', message: 'The draft could not be read. Reload the page.', fieldErrors: {}, values: {} };
  }
  const tableIds = JSON.parse(text(form, 'items') || '[]') as string[];
  let loaded: RateManual;
  try {
    loaded = await api<RateManual>('/v1/rate-manuals', {
      method: 'POST',
      body: {
        ...(manual as object),
        code: text(form, 'code').toUpperCase(),
        state: text(form, 'state').toUpperCase(),
        benefit: text(form, 'benefit').toUpperCase(),
        effectiveFrom: text(form, 'effectiveFrom'),
        source: `${text(form, 'source')} (drafted by AG-02, checked against the filed pages by the analyst who loaded it)`,
      },
    });
    await resolve(id, { accepted: tableIds, appliedTo: { type: 'rate_manual', id: loaded.id }, note: text(form, 'note') || undefined });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath(`/proposals/${id}`);
  redirect(`/proposals/${id}?done=loaded&manual=${loaded.id}`);
}
