import { z } from 'zod';

/**
 * Event catalogue. Each event type has a versioned data schema; producers validate before writing to
 * the outbox, and consumers can rely on the schema for the version they declare.
 */
export interface EventDefinition<TType extends string, TSchema extends z.ZodType> {
  type: TType;
  version: number;
  source: string;
  schema: TSchema;
}

function defineEvent<TType extends string, TSchema extends z.ZodType>(
  def: EventDefinition<TType, TSchema>,
): EventDefinition<TType, TSchema> {
  return def;
}

export const AccountRegistered = defineEvent({
  type: 'AccountRegistered',
  version: 1,
  source: 'astra.platform.accounts',
  schema: z.object({
    accountId: z.uuid(),
    code: z.string(),
    name: z.string(),
    kind: z.string(),
  }),
});

export const AccountStatusChanged = defineEvent({
  type: 'AccountStatusChanged',
  version: 1,
  source: 'astra.platform.accounts',
  schema: z.object({
    accountId: z.uuid(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  }),
});

export const WebhookSubscriptionCreated = defineEvent({
  type: 'WebhookSubscriptionCreated',
  version: 1,
  source: 'astra.integration.webhooks',
  schema: z.object({
    subscriptionId: z.uuid(),
    url: z.string(),
    eventTypes: z.array(z.string()),
  }),
});

export const WebhookSubscriptionStatusChanged = defineEvent({
  type: 'WebhookSubscriptionStatusChanged',
  version: 1,
  source: 'astra.integration.webhooks',
  schema: z.object({
    subscriptionId: z.uuid(),
    from: z.string(),
    to: z.string(),
  }),
});

export const FeatureFlagChanged = defineEvent({
  type: 'FeatureFlagChanged',
  version: 1,
  source: 'astra.platform.flags',
  schema: z.object({
    key: z.string(),
    accountId: z.uuid().nullable(),
    enabled: z.boolean().nullable(),
  }),
});

export const EVENT_CATALOGUE = [
  AccountRegistered,
  AccountStatusChanged,
  WebhookSubscriptionCreated,
  WebhookSubscriptionStatusChanged,
  FeatureFlagChanged,
] as const;

export type CatalogueEventType = (typeof EVENT_CATALOGUE)[number]['type'];
export const EVENT_TYPES = EVENT_CATALOGUE.map((e) => e.type) as CatalogueEventType[];
