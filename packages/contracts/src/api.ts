import { z } from 'zod';
import { ROLES, PERMISSIONS, type Permission } from './rbac';

/** Shared request/response schemas for the v1 platform API. */

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

// ---------- Identity ----------

export const AccountScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('accounts'), accountIds: z.array(z.uuid()) }),
]);
export type AccountScope = z.infer<typeof AccountScopeSchema>;

export const MeSchema = z.object({
  subject: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  roles: z.array(z.enum(ROLES)),
  permissions: z.array(z.enum(Object.keys(PERMISSIONS) as [Permission, ...Permission[]])),
  accountScope: AccountScopeSchema,
});
export type Me = z.infer<typeof MeSchema>;

// ---------- Accounts (tenant registry) ----------

export const ACCOUNT_KINDS = ['travel_account', 'card_issuer', 'bank'] as const;
export const ACCOUNT_STATUSES = ['onboarding', 'active', 'suspended', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Allowed status moves. Moving an account from onboarding to active requires the onboarding
 * checklist (E07-F01-S01), so that transition is added with the Accounts epic.
 */
export const ACCOUNT_STATUS_TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  onboarding: ['closed'],
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: [],
};

export const AccountSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(ACCOUNT_KINDS),
  status: z.enum(ACCOUNT_STATUSES),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Account = z.infer<typeof AccountSchema>;

export const CreateAccountRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, 'Use 2 to 32 upper-case letters, digits, - or _'),
  name: z.string().trim().min(2).max(200),
  kind: z.enum(ACCOUNT_KINDS),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequestSchema>;

export const ChangeAccountStatusRequestSchema = z.object({
  status: z.enum(ACCOUNT_STATUSES),
  reason: z.string().trim().min(3).max(500),
});

// ---------- Webhook subscriptions ----------

export const WEBHOOK_STATUSES = ['active', 'paused', 'disabled'] as const;

export const WebhookSubscriptionSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  description: z.string().nullable(),
  status: z.enum(WEBHOOK_STATUSES),
  consecutiveFailures: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: z.string(),
});
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;

export const CreateWebhookSubscriptionRequestSchema = z.object({
  accountId: z.uuid().optional(),
  url: z.url({ protocol: /^https?$/ }).max(2000),
  eventTypes: z.array(z.string().min(1)).min(1).max(50),
  description: z.string().trim().max(200).optional(),
});

export const CreatedWebhookSubscriptionSchema = WebhookSubscriptionSchema.extend({
  /** Returned once at creation. Used to verify the `Astra-Signature` header. */
  signingSecret: z.string(),
});

export const ChangeWebhookStatusRequestSchema = z.object({
  status: z.enum(['active', 'paused']),
});

// ---------- Feature flags ----------

export const FeatureFlagSchema = z.object({
  key: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  overrides: z.array(z.object({ accountId: z.uuid(), enabled: z.boolean() })),
  updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: z.string().nullable(),
});
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

export const SetFeatureFlagRequestSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});

// ---------- Events and deliveries ----------

export const DELIVERY_STATUSES = ['pending', 'delivered', 'dead'] as const;

export const DeliverySchema = z.object({
  eventId: z.uuid(),
  eventType: z.string(),
  subscriber: z.string(),
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.number().int(),
  nextAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  accountId: z.uuid().nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const EventRecordSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  version: z.number().int(),
  time: z.iso.datetime({ offset: true }),
  source: z.string(),
  correlationId: z.string(),
  accountId: z.uuid().nullable(),
  state: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

export const ReplayResultSchema = z.object({ replayed: z.number().int() });

// ---------- Audit ----------

export const AUDIT_ACTOR_TYPES = ['user', 'partner', 'agent', 'system'] as const;

export const AuditEntrySchema = z.object({
  seq: z.string(),
  id: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  actorType: z.enum(AUDIT_ACTOR_TYPES),
  actorId: z.string(),
  actorName: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  accountId: z.uuid().nullable(),
  correlationId: z.string(),
  reason: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  sealed: z.boolean(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditVerificationSchema = z.object({
  ok: z.boolean(),
  rowsChecked: z.number().int(),
  sealsChecked: z.number().int(),
  lastSealedSeq: z.string().nullable(),
  firstMismatch: z.object({ kind: z.enum(['row', 'seal']), ref: z.string() }).nullable(),
  checkedAt: z.iso.datetime({ offset: true }),
});
export type AuditVerification = z.infer<typeof AuditVerificationSchema>;
