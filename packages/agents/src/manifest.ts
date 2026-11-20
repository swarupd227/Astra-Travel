import { createHash } from 'node:crypto';
import type { AutonomyLevel, Permission, WarrantDocument } from '@astra/contracts';
import { canonicalJson } from '@astra/platform';
import { TOOL_CATALOGUE, toolInputSchema } from './tools';

/**
 * An agent as code. The registry stores a version per distinct manifest, identified by a hash of
 * everything that shapes behaviour: model, effort, prompt, tool definitions and data access. Approval is
 * granted to that hash, so changed code cannot run until it is approved again.
 */
export interface EvalCase {
  id: string;
  description: string;
  question: string;
  /** A case that must pass for the evaluation to pass, whatever the overall score. */
  critical: boolean;
  expect: {
    /** Every tool listed must be called at least once. */
    toolsCalled?: string[];
    /** None of these tools may be called. */
    toolsNotCalled?: string[];
    /** Case-insensitive regular expressions the answer must match. */
    answerMatches?: string[];
    /** Case-insensitive regular expressions the answer must not match. */
    answerNotMatches?: string[];
  };
}

export interface EvalSetDefinition {
  name: string;
  threshold: number;
  cases: EvalCase[];
}

export interface AgentManifest {
  id: string;
  name: string;
  purpose: string;
  ownerRole: string;
  autonomy: AutonomyLevel;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  promptVersion: string;
  systemPrompt: string;
  tools: string[];
  dataAccess: Permission[];
  /** Starting points a governance lead can adopt. Neither applies until a person sets it. */
  proposedWarrant: WarrantDocument;
  proposedBudget: { monthlyLimitUsd: number; alertThresholdPct: number };
  evalSets: EvalSetDefinition[];
}

export function configHash(m: AgentManifest): string {
  const tools = m.tools.map((name) => {
    const t = TOOL_CATALOGUE[name];
    if (!t) throw new Error(`Agent ${m.id} uses unknown tool ${name}`);
    return {
      name,
      description: t.description,
      schema: toolInputSchema(t),
      permission: t.permission,
      risk: t.risk,
    };
  });
  return createHash('sha256')
    .update(
      canonicalJson({
        model: m.model,
        effort: m.effort,
        maxTokens: m.maxTokens,
        promptVersion: m.promptVersion,
        systemPrompt: m.systemPrompt,
        tools,
        dataAccess: [...m.dataAccess].sort(),
        autonomy: m.autonomy,
      }),
    )
    .digest('hex');
}

export function evalSetHash(set: EvalSetDefinition): string {
  return createHash('sha256').update(canonicalJson(set)).digest('hex');
}
