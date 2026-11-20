'use server';

import type { AgentRun, AgentRunDetail } from '@astra/contracts';
import { api, ApiProblem } from '@/lib/api';

export type AskResult = { ok: true; runId: string } | { ok: false; message: string };

export async function askCopilot(question: string, idempotencyKey: string): Promise<AskResult> {
  try {
    const run = await api<AgentRun>('/v1/agents/AG-10/runs', {
      method: 'POST',
      idempotencyKey,
      body: { question },
    });
    return { ok: true, runId: run.id };
  } catch (err) {
    if (err && typeof err === 'object' && 'digest' in err) throw err;
    const fieldMessage = err instanceof ApiProblem ? err.problem.errors?.[0]?.message : undefined;
    return {
      ok: false,
      message:
        fieldMessage ??
        (err instanceof ApiProblem ? err.message : 'The question could not be sent.'),
    };
  }
}

export interface RunProgress {
  status: AgentRun['status'];
  stopReason: string | null;
  answer: string | null;
  activity: string[];
  costUsd: string;
  modelsServed: string[];
  agentVersion: number;
}

export async function runProgress(runId: string): Promise<RunProgress> {
  const run = await api<AgentRunDetail>(`/v1/agent-runs/${encodeURIComponent(runId)}`);
  return {
    status: run.status,
    stopReason: run.stopReason,
    answer: typeof run.output?.answer === 'string' ? run.output.answer : null,
    activity: run.steps
      .filter((s) => s.kind === 'tool_call' && s.decision === 'allowed')
      .map((s) => s.name ?? ''),
    costUsd: run.costUsd,
    modelsServed: run.modelsServed,
    agentVersion: run.agentVersion,
  };
}
