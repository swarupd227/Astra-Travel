'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { AgentRun } from '@astra/contracts';
import { api, ApiProblem } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

/** A person asks the Underwriting Referral agent (AG-04) to summarise this referral. It acts with at most their own access. */
export async function summariseReferral(form: FormData) {
  const referralId = text(form, 'referralId');
  if (!/^[0-9a-f-]{36}$/i.test(referralId)) redirect('/underwriting/referrals');
  try {
    await api<AgentRun>('/v1/agents/AG-04/runs', { method: 'POST', body: { question: `Summarise referral ${referralId}.` }, idempotencyKey: randomUUID() });
  } catch (err) {
    if (err instanceof ApiProblem) redirect(`/underwriting/referrals/${referralId}?askError=${encodeURIComponent(err.problem.detail ?? err.problem.title)}`);
    throw err;
  }
  redirect(`/underwriting/referrals/${referralId}?asked=1`);
}

/** Accept, edit or reject the agent's summary, with the reason evaluation will learn from. */
export async function decideSummary(_prev: ActionState, form: FormData): Promise<ActionState> {
  const summaryId = text(form, 'summaryId');
  const decision = text(form, 'decision');
  try {
    await api(`/v1/referral-summaries/${encodeURIComponent(summaryId)}/decision`, {
      method: 'POST',
      body: {
        decision,
        ...(decision === 'edited' ? { editedSummary: text(form, 'editedSummary') } : {}),
        ...(text(form, 'reason') ? { reason: text(form, 'reason') } : {}),
      },
    });
  } catch (err) {
    return fromError(err, form);
  }
  revalidatePath('/underwriting/referrals');
  return { status: 'success', message: decision === 'accepted' ? 'Recorded: you accepted the summary.' : decision === 'edited' ? 'Recorded: your edited summary replaces it.' : 'Recorded: you rejected the summary.' };
}
