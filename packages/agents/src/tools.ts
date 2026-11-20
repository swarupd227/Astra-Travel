import { z } from 'zod';
import type { Permission } from '@astra/contracts';
import type { AgentApiClient } from './api-client';

/**
 * The approved tool catalogue (E15-F02-S01). Every tool wraps a platform API and names the permission it
 * needs, so an agent can never do more than the person it acts for. Tools the specification forbids to
 * agents (publishing plans or manuals, declining cover, overriding sanctions, changing warrants) are never
 * added here.
 */
export interface ToolDefinition<TInput extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: TInput;
  permission: Permission;
  /** Write tools are refused for L0 and L1 agents whatever their warrant says. */
  risk: 'read' | 'write';
  run(input: z.infer<TInput>, api: AgentApiClient): Promise<unknown>;
}

function defineTool<T extends z.ZodType>(def: ToolDefinition<T>): ToolDefinition<T> {
  return def;
}

const limit = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe('Maximum rows to return (default 20).');

export const listAccounts = defineTool({
  name: 'list_accounts',
  description:
    'List accounts (travel sellers, card issuers and banks) the requester can see. Filter by status, kind or a name/code search. Returns id, code, name, kind, status and timestamps, plus nextCursor when more rows exist.',
  input: z.strictObject({
    status: z.enum(['onboarding', 'active', 'suspended', 'closed']).optional(),
    kind: z.enum(['travel_account', 'card_issuer', 'bank']).optional(),
    query: z.string().max(100).optional().describe('Text to match in the account name or code.'),
    limit,
  }),
  permission: 'accounts:read',
  risk: 'read',
  run: (i, api) =>
    api.get('/v1/accounts', { status: i.status, kind: i.kind, q: i.query, limit: i.limit ?? 20 }),
});

export const getAccount = defineTool({
  name: 'get_account',
  description: 'Get one account by its UUID.',
  input: z.strictObject({ accountId: z.uuid() }),
  permission: 'accounts:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/accounts/${i.accountId}`),
});

export const listEvents = defineTool({
  name: 'list_events',
  description:
    'List business events, newest first. Filter by event type (for example AccountRegistered), account UUID or correlation ID.',
  input: z.strictObject({
    type: z.string().max(64).optional(),
    accountId: z.uuid().optional(),
    correlationId: z.string().max(128).optional(),
    limit,
  }),
  permission: 'events:read',
  risk: 'read',
  run: (i, api) =>
    api.get('/v1/events', {
      type: i.type,
      accountId: i.accountId,
      correlationId: i.correlationId,
      limit: i.limit ?? 20,
    }),
});

export const listDeliveries = defineTool({
  name: 'list_event_deliveries',
  description:
    'List event deliveries to subscribers. Use status "dead" for the dead-letter queue (deliveries that used up their retries), "pending" for deliveries still being retried.',
  input: z.strictObject({
    status: z.enum(['pending', 'delivered', 'dead']).optional(),
    subscriber: z.string().max(200).optional(),
    limit,
  }),
  permission: 'events:read',
  risk: 'read',
  run: (i, api) =>
    api.get('/v1/event-deliveries', {
      status: i.status,
      subscriber: i.subscriber,
      limit: i.limit ?? 20,
    }),
});

export const searchAudit = defineTool({
  name: 'search_audit_trail',
  description:
    'Search the audit trail, newest first: who did what, when and why. Filter by action (for example account.registered), actor type, actor ID, resource type and ID, account UUID or correlation ID.',
  input: z.strictObject({
    action: z.string().max(100).optional(),
    actorType: z.enum(['user', 'partner', 'agent', 'system']).optional(),
    actorId: z.string().max(200).optional(),
    resourceType: z.string().max(100).optional(),
    resourceId: z.string().max(200).optional(),
    accountId: z.uuid().optional(),
    correlationId: z.string().max(128).optional(),
    limit,
  }),
  permission: 'audit:read',
  risk: 'read',
  run: (i, api) =>
    api.get('/v1/audit', {
      action: i.action,
      actorType: i.actorType,
      actorId: i.actorId,
      resourceType: i.resourceType,
      resourceId: i.resourceId,
      accountId: i.accountId,
      correlationId: i.correlationId,
      limit: i.limit ?? 20,
    }),
});

export const listFeatureFlags = defineTool({
  name: 'list_feature_flags',
  description: 'List feature flags with their global value and per-account overrides.',
  input: z.strictObject({}),
  permission: 'flags:read',
  risk: 'read',
  run: (_i, api) => api.get('/v1/feature-flags'),
});

export const TOOL_CATALOGUE: Record<string, ToolDefinition> = Object.fromEntries(
  [listAccounts, getAccount, listEvents, listDeliveries, searchAudit, listFeatureFlags].map((t) => [
    t.name,
    t as unknown as ToolDefinition,
  ]),
);

/** JSON Schema for a tool's input, in the form the Messages API expects. */
export function toolInputSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
