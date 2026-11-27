import { z } from 'zod';

/** Increment 15: the workbench (E11-F01-S01, E11-F02-S01, E11-F02-S02, E03-F05-S01). Design: docs/adr/0016. */

// ---------------------------------------------------------------- Task queue

export const TASK_SOURCES = [
  'referral',
  'sanctions_hold',
  'agent_proposal',
  'agent_review',
  'delivery_failure',
  'event_delivery',
] as const;
export const TaskSourceSchema = z.enum(TASK_SOURCES);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const TASK_SOURCE_LABELS: Record<TaskSource, string> = {
  referral: 'Referral',
  sanctions_hold: 'Sanctions hold',
  agent_proposal: 'Agent proposal',
  agent_review: 'Agent review',
  delivery_failure: 'Failed delivery',
  event_delivery: 'Undelivered event',
};

export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/** Where a task stands against its timer: over, in its last quarter, or comfortably inside. */
export const TaskTimerSchema = z.enum(['on_track', 'at_risk', 'overdue']);
export type TaskTimer = z.infer<typeof TaskTimerSchema>;

export const TaskSchema = z.object({
  sourceType: TaskSourceSchema,
  sourceId: z.uuid(),
  title: z.string(),
  summary: z.string(),
  accountId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  link: z.string(),
  priority: TaskPrioritySchema,
  targetHours: z.number().int(),
  dueAt: z.iso.datetime(),
  timer: TaskTimerSchema,
  /** Whole minutes left, negative once overdue. */
  minutesLeft: z.number().int(),
  owner: z.string().nullable(),
  ownerName: z.string().nullable(),
  assignedAt: z.iso.datetime().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskListSchema = z.object({
  items: z.array(TaskSchema),
  total: z.number().int(),
  counts: z.object({
    overdue: z.number().int(),
    atRisk: z.number().int(),
    unassigned: z.number().int(),
  }),
});
export type TaskList = z.infer<typeof TaskListSchema>;

export const AssignTaskSchema = z.object({
  /** The person to give the work to; null hands it back to the queue. */
  owner: z.string().trim().min(1).max(200).nullable(),
  ownerName: z.string().trim().max(200).nullable().optional(),
});

export const SlaPolicySchema = z.object({
  sourceType: TaskSourceSchema,
  priority: TaskPrioritySchema,
  targetHours: z.number().int().min(1).max(720),
  updatedBy: z.string(),
  updatedAt: z.iso.datetime(),
});
export type SlaPolicy = z.infer<typeof SlaPolicySchema>;
export const SlaPolicyInputSchema = z.object({
  priority: TaskPrioritySchema,
  targetHours: z.number().int().min(1).max(720),
});

/** The state of a timer from the minutes left and the whole target. */
export function timerState(minutesLeft: number, targetHours: number): TaskTimer {
  if (minutesLeft < 0) return 'overdue';
  return minutesLeft <= (targetHours * 60) / 4 ? 'at_risk' : 'on_track';
}

// ---------------------------------------------------------------- Search

export const SearchHitSchema = z.object({
  policyId: z.uuid(),
  number: z.string(),
  status: z.enum(['active', 'cancelled', 'expired']),
  accountId: z.uuid(),
  accountName: z.string(),
  planCode: z.string(),
  travellers: z.array(z.string()),
  departureDate: z.string().nullable(),
  returnDate: z.string().nullable(),
  destinations: z.array(z.string()),
  /** What matched: policy number, traveller, account, or trip. */
  matchedOn: z.array(z.enum(['number', 'traveller', 'account', 'trip'])),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;
export const SearchResultSchema = z.object({
  query: z.string(),
  items: z.array(SearchHitSchema),
  tookMs: z.number().int(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ---------------------------------------------------------------- AG-04 referral summaries and decisions about agent output

export const REFERRAL_SUGGESTIONS = ['approve', 'decline', 'needs_information'] as const;
export const ReferralSuggestionSchema = z.enum(REFERRAL_SUGGESTIONS);

export const ReferralSummaryInputSchema = z.object({
  summary: z.string().trim().min(20).max(4000),
  /** Codes of the rules the summary relies on; each must be one that fired on this referral. */
  rulesCited: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  suggested: ReferralSuggestionSchema,
  runId: z.uuid().nullable().optional(),
});
export type ReferralSummaryInput = z.infer<typeof ReferralSummaryInputSchema>;

export const ReferralSummarySchema = z.object({
  id: z.uuid(),
  referralId: z.uuid(),
  runId: z.uuid().nullable(),
  agentId: z.string().nullable(),
  summary: z.string(),
  rulesCited: z.array(z.string()),
  suggested: ReferralSuggestionSchema,
  verification: z.object({
    rulesChecked: z.array(z.object({ code: z.string(), fired: z.boolean() })),
    allCitedRulesFired: z.boolean(),
  }),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  decision: z
    .object({
      decision: z.enum(['accepted', 'edited', 'rejected']),
      edited: z.object({ summary: z.string() }).nullable(),
      reason: z.string().nullable(),
      decidedBy: z.string(),
      decidedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type ReferralSummary = z.infer<typeof ReferralSummarySchema>;

export const OutputDecisionInputSchema = z
  .object({
    decision: z.enum(['accepted', 'edited', 'rejected']),
    editedSummary: z.string().trim().min(20).max(4000).optional(),
    reason: z.string().trim().min(3).max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'edited' && !v.editedSummary)
      ctx.addIssue({
        code: 'custom',
        path: ['editedSummary'],
        message: 'Give the corrected summary',
      });
    if (v.decision !== 'accepted' && !v.reason)
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Say why, so evaluation can learn from it',
      });
  });
export type OutputDecisionInput = z.infer<typeof OutputDecisionInputSchema>;

/** What a person needs to judge an agent's output (E11-F02-S02): inputs, evidence, reasoning, warrant limits. */
export const AgentRunReviewSchema = z.object({
  runId: z.uuid(),
  agentId: z.string(),
  agentName: z.string(),
  agentVersion: z.number().int(),
  status: z.string(),
  requestedBy: z.string(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  /** Everything the agent read or did, in order: tool calls with their results, guardrail and warrant decisions. */
  evidence: z.array(
    z.object({
      seq: z.number().int(),
      kind: z.string(),
      name: z.string().nullable(),
      decision: z.string().nullable(),
      detail: z.unknown(),
      at: z.iso.datetime(),
    }),
  ),
  reasoning: z.string().nullable(),
  warrant: z
    .object({
      version: z.number().int(),
      tools: z.array(z.object({ name: z.string(), maxCallsPerRun: z.number().int().nullable() })),
      dataAccess: z.array(z.string()),
      maxModelTurns: z.number().int().nullable(),
      maxCostPerRunUsd: z.number().nullable(),
      escalationRole: z.string().nullable(),
    })
    .nullable(),
  usage: z.object({ turns: z.number().int(), toolCalls: z.number().int(), costUsd: z.number() }),
  decisions: z.array(
    z.object({
      subjectType: z.string(),
      subjectId: z.uuid(),
      decision: z.string(),
      reason: z.string().nullable(),
      decidedBy: z.string(),
      decidedAt: z.iso.datetime(),
    }),
  ),
});
export type AgentRunReview = z.infer<typeof AgentRunReviewSchema>;
