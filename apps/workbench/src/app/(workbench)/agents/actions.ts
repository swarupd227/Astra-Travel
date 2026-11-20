'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { fromError, text, type ActionState } from '@/lib/actions';

const done = (agentId: string, message: string): ActionState => {
  revalidatePath(`/agents/${agentId}`);
  revalidatePath('/agents');
  return { status: 'success', message };
};

export async function setAgentStatus(_prev: ActionState, form: FormData): Promise<ActionState> {
  const agentId = text(form, 'agentId');
  const status = text(form, 'status');
  try {
    await api(`/v1/agents/${encodeURIComponent(agentId)}/status`, {
      method: 'POST',
      body: { status, reason: text(form, 'reason') },
    });
    revalidatePath('/copilot');
    return done(
      agentId,
      status === 'paused'
        ? 'The agent is paused. Its queued work went to people.'
        : 'The agent is active again.',
    );
  } catch (err) {
    return fromError(err, form);
  }
}

export async function setWarrant(_prev: ActionState, form: FormData): Promise<ActionState> {
  const agentId = text(form, 'agentId');
  let document: unknown;
  try {
    document = JSON.parse(text(form, 'document'));
  } catch {
    return {
      status: 'error',
      message: 'The warrant is not valid JSON.',
      fieldErrors: { document: 'Check the JSON syntax.' },
      values: { document: [text(form, 'document')], reason: [text(form, 'reason')] },
    };
  }
  try {
    const w = await api<{ version: number }>(`/v1/agents/${encodeURIComponent(agentId)}/warrant`, {
      method: 'PUT',
      body: { document, reason: text(form, 'reason') },
    });
    return done(agentId, `Warrant version ${w.version} is now in force.`);
  } catch (err) {
    return fromError(err, form);
  }
}

export async function setBudget(_prev: ActionState, form: FormData): Promise<ActionState> {
  const agentId = text(form, 'agentId');
  try {
    await api(`/v1/agents/${encodeURIComponent(agentId)}/budget`, {
      method: 'PUT',
      body: {
        monthlyLimitUsd: Number(text(form, 'monthlyLimitUsd')),
        alertThresholdPct: Number(text(form, 'alertThresholdPct')),
        reason: text(form, 'reason'),
      },
    });
    return done(agentId, 'Budget saved.');
  } catch (err) {
    return fromError(err, form);
  }
}

export async function startEvaluation(_prev: ActionState, form: FormData): Promise<ActionState> {
  const agentId = text(form, 'agentId');
  try {
    await api(`/v1/agents/${encodeURIComponent(agentId)}/evaluations`, {
      method: 'POST',
      body: { evalSet: text(form, 'evalSet'), agentVersion: Number(text(form, 'agentVersion')) },
    });
    return done(agentId, 'Evaluation started. Results appear below when it finishes.');
  } catch (err) {
    return fromError(err, form);
  }
}

export async function decideVersion(_prev: ActionState, form: FormData): Promise<ActionState> {
  const agentId = text(form, 'agentId');
  const version = text(form, 'version');
  const decision = text(form, 'decision');
  try {
    await api(
      `/v1/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(version)}/decision`,
      {
        method: 'POST',
        body: { decision, reason: text(form, 'reason') },
      },
    );
    revalidatePath('/copilot');
    return done(
      agentId,
      decision === 'approve'
        ? `Version ${version} is approved and live.`
        : `Version ${version} was rejected.`,
    );
  } catch (err) {
    return fromError(err, form);
  }
}

export async function resolveReview(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await api(`/v1/agent-reviews/${encodeURIComponent(text(form, 'reviewId'))}/resolve`, {
      method: 'POST',
      body: { resolution: text(form, 'resolution'), note: text(form, 'note') },
    });
    revalidatePath('/agents/reviews');
    revalidatePath('/agents');
    return { status: 'success', message: 'Resolved.' };
  } catch (err) {
    return fromError(err, form);
  }
}
