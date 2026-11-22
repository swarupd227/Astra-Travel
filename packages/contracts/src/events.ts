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

export const AgentStatusChanged = defineEvent({
  type: 'AgentStatusChanged',
  version: 1,
  source: 'astra.agents.registry',
  schema: z.object({ agentId: z.string(), from: z.string(), to: z.string(), reason: z.string() }),
});

export const AgentVersionDecided = defineEvent({
  type: 'AgentVersionDecided',
  version: 1,
  source: 'astra.agents.registry',
  schema: z.object({
    agentId: z.string(),
    version: z.number().int(),
    decision: z.enum(['approved', 'rejected']),
  }),
});

export const AgentWarrantChanged = defineEvent({
  type: 'AgentWarrantChanged',
  version: 1,
  source: 'astra.agents.warrants',
  schema: z.object({ agentId: z.string(), version: z.number().int() }),
});

export const AgentRunFinished = defineEvent({
  type: 'AgentRunFinished',
  version: 1,
  source: 'astra.agents.runtime',
  schema: z.object({
    runId: z.uuid(),
    agentId: z.string(),
    status: z.string(),
    costUsd: z.string(),
  }),
});

export const AgentReviewRaised = defineEvent({
  type: 'AgentReviewRaised',
  version: 1,
  source: 'astra.agents.runtime',
  schema: z.object({
    reviewId: z.uuid(),
    agentId: z.string(),
    kind: z.string(),
    runId: z.uuid().nullable(),
  }),
});

export const MasterPolicyRegistered = defineEvent({
  type: 'MasterPolicyRegistered',
  version: 1,
  source: 'astra.card.programmes',
  schema: z.object({ masterPolicyId: z.uuid(), policyNumber: z.string(), underwriter: z.string() }),
});

export const CardProgrammeRegistered = defineEvent({
  type: 'CardProgrammeRegistered',
  version: 1,
  source: 'astra.card.programmes',
  schema: z.object({ programmeId: z.uuid(), code: z.string(), masterPolicyId: z.uuid() }),
});

export const CardProgrammeStatusChanged = defineEvent({
  type: 'CardProgrammeStatusChanged',
  version: 1,
  source: 'astra.card.programmes',
  schema: z.object({ programmeId: z.uuid(), from: z.string(), to: z.string(), reason: z.string() }),
});

export const EligibilityFeedReceived = defineEvent({
  type: 'EligibilityFeedReceived',
  version: 1,
  source: 'astra.card.eligibility',
  schema: z.object({
    feedId: z.uuid(),
    programmeId: z.uuid(),
    mode: z.string(),
    sha256: z.string(),
  }),
});

export const EligibilityFeedLoaded = defineEvent({
  type: 'EligibilityFeedLoaded',
  version: 1,
  source: 'astra.card.eligibility',
  schema: z.object({
    feedId: z.uuid(),
    programmeId: z.uuid(),
    sequence: z.number().int().nullable(),
    mode: z.string(),
    status: z.string(),
    reason: z.string().nullable(),
    added: z.number().int(),
    updated: z.number().int(),
    removed: z.number().int(),
    rejected: z.number().int(),
    certificatesIssued: z.number().int(),
  }),
});

export const ReferenceDataApproved = defineEvent({
  type: 'ReferenceDataApproved',
  version: 1,
  source: 'astra.refdata',
  schema: z.object({
    dataset: z.string(),
    versionId: z.uuid(),
    version: z.number().int(),
    effectiveFrom: z.string(),
    entryCount: z.number().int(),
  }),
});

export const FilingStatusChanged = defineEvent({
  type: 'FilingStatusChanged',
  version: 1,
  source: 'astra.compliance.filings',
  schema: z.object({
    filingId: z.uuid(),
    state: z.string(),
    itemType: z.string(),
    itemReference: z.string(),
    from: z.string().nullable(),
    to: z.string(),
    effectiveFrom: z.string().nullable(),
  }),
});

export const FormEditionLoaded = defineEvent({
  type: 'FormEditionLoaded',
  version: 1,
  source: 'astra.studio.forms',
  schema: z.object({
    editionId: z.uuid(),
    formNumber: z.string(),
    edition: z.string(),
    sha256: z.string(),
  }),
});

export const VariableMapApproved = defineEvent({
  type: 'VariableMapApproved',
  version: 1,
  source: 'astra.studio.forms',
  schema: z.object({
    editionId: z.uuid(),
    mapId: z.uuid(),
    version: z.number().int(),
    variables: z.number().int(),
  }),
});
export const EVENT_CATALOGUE = [
  AccountRegistered,
  AccountStatusChanged,
  WebhookSubscriptionCreated,
  WebhookSubscriptionStatusChanged,
  FeatureFlagChanged,
  AgentStatusChanged,
  AgentVersionDecided,
  AgentWarrantChanged,
  AgentRunFinished,
  AgentReviewRaised,
  MasterPolicyRegistered,
  CardProgrammeRegistered,
  CardProgrammeStatusChanged,
  EligibilityFeedReceived,
  EligibilityFeedLoaded,
  ReferenceDataApproved,
  FilingStatusChanged,
  FormEditionLoaded,
  VariableMapApproved,
] as const;

export type CatalogueEventType = (typeof EVENT_CATALOGUE)[number]['type'];
export const EVENT_TYPES = EVENT_CATALOGUE.map((e) => e.type) as CatalogueEventType[];
