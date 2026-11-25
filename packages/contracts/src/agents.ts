import { z } from 'zod';
import { PERMISSIONS, type Permission } from './rbac';

/** Contracts for the agent platform (specification section 10, epic E15). */

export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  L0: 'Assist: answers and drafts, takes no action',
  L1: 'Recommend: prepares a decision, a person decides',
  L2: 'Act with approval: acts after a person approves',
  L3: 'Act within limits: acts alone within its warrant',
};

export const AGENT_STATUSES = ['active', 'paused', 'retired'] as const;
export const RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'stopped',
  'escalated',
] as const;
export const REVIEW_KINDS = [
  'warrant_refusal',
  'guardrail',
  'agent_paused',
  'budget',
  'run_failed',
  'model_refusal',
  'servicing_request',
] as const;

const permissionEnum = z.enum(Object.keys(PERMISSIONS) as [Permission, ...Permission[]]);

/**
 * A warrant: the machine-readable mandate checked before every tool call (E15-F01-S02).
 * Tools not listed are refused; listed tools are limited per run.
 */
export const WarrantDocumentSchema = z.strictObject({
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        maxCallsPerRun: z.number().int().min(1).max(100),
      }),
    )
    .max(50),
  /** Permissions the agent may use, further limited by the person it acts for. */
  dataAccess: z.array(permissionEnum).max(50),
  maxModelTurns: z.number().int().min(1).max(50),
  maxCostPerRunUsd: z.number().positive().max(100),
  /** Who receives escalations and refusals, by role. */
  escalationRole: z.string().min(1),
  /** Account scope the agent may work in: all of the requester's accounts, or none. */
  accountScope: z.enum(['requester', 'none']),
});
export type WarrantDocument = z.infer<typeof WarrantDocumentSchema>;

export const AgentVersionSchema = z.object({
  version: z.number().int(),
  configHash: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  tools: z.array(z.string()),
  dataAccess: z.array(z.string()),
  effort: z.string(),
  registeredAt: z.iso.datetime({ offset: true }),
  approvalStatus: z.enum(['pending', 'approved', 'rejected', 'retired']),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
  approvalReason: z.string().nullable(),
  latestEvaluation: z
    .object({
      id: z.uuid(),
      status: z.string(),
      score: z.number().nullable(),
      passed: z.boolean().nullable(),
      finishedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .nullable(),
});

export const AgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  ownerRole: z.string(),
  autonomy: z.enum(AUTONOMY_LEVELS),
  status: z.enum(AGENT_STATUSES),
  statusReason: z.string().nullable(),
  statusChangedAt: z.iso.datetime({ offset: true }),
  statusChangedBy: z.string(),
  liveVersion: z.number().int().nullable(),
  latestVersion: z.number().int(),
  model: z.string(),
  warrantVersion: z.number().int().nullable(),
  budget: z
    .object({
      monthlyLimitUsd: z.string(),
      alertThresholdPct: z.number().int(),
      spentThisMonthUsd: z.string(),
    })
    .nullable(),
  openReviews: z.number().int(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const EvalSetSchema = z.object({
  name: z.string(),
  version: z.number().int(),
  threshold: z.number(),
  caseCount: z.number().int(),
});

export const AgentDetailSchema = AgentSummarySchema.extend({
  versions: z.array(AgentVersionSchema),
  warrant: z
    .object({
      version: z.number().int(),
      document: WarrantDocumentSchema,
      reason: z.string(),
      createdBy: z.string(),
      createdAt: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  evalSets: z.array(EvalSetSchema),
  /** Starting points from the agent's code. They apply only when a person sets them. */
  proposedWarrant: WarrantDocumentSchema.nullable(),
  proposedBudget: z
    .object({ monthlyLimitUsd: z.number(), alertThresholdPct: z.number().int() })
    .nullable(),
  autonomyLabel: z.string(),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

export const RunStepSchema = z.object({
  seq: z.number().int(),
  at: z.iso.datetime({ offset: true }),
  kind: z.string(),
  name: z.string().nullable(),
  decision: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});

export const AgentRunSchema = z.object({
  id: z.uuid(),
  agentId: z.string(),
  agentVersion: z.number().int(),
  warrantVersion: z.number().int().nullable(),
  purpose: z.enum(['request', 'evaluation']),
  status: z.enum(RUN_STATUSES),
  stopReason: z.string().nullable(),
  requestedBy: z.string(),
  requestedByName: z.string().nullable(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  modelRequested: z.string().nullable(),
  modelsServed: z.array(z.string()),
  promptVersion: z.string().nullable(),
  turns: z.number().int(),
  toolCalls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.string(),
  correlationId: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AgentRunDetailSchema = AgentRunSchema.extend({ steps: z.array(RunStepSchema) });
export type AgentRunDetail = z.infer<typeof AgentRunDetailSchema>;

export const AgentReviewSchema = z.object({
  id: z.uuid(),
  agentId: z.string(),
  runId: z.uuid().nullable(),
  kind: z.enum(REVIEW_KINDS),
  status: z.enum(['open', 'resolved']),
  summary: z.string(),
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  resolution: z.enum(['accepted', 'rejected', 'handled']).nullable(),
  resolutionNote: z.string().nullable(),
});
export type AgentReview = z.infer<typeof AgentReviewSchema>;

export const EvalRunSchema = z.object({
  id: z.uuid(),
  agentId: z.string(),
  agentVersion: z.number().int(),
  evalSet: z.string(),
  evalSetVersion: z.number().int(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  score: z.number().nullable(),
  passed: z.boolean().nullable(),
  results: z.array(z.record(z.string(), z.unknown())).nullable(),
  error: z.string().nullable(),
  costUsd: z.string(),
  startedBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

export const StartRunRequestSchema = z.object({
  question: z.string().trim().min(3).max(4000),
});

export const ReasonSchema = z.string().trim().min(3).max(500);
