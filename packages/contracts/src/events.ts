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
export const BenefitCatalogueApproved = defineEvent({
  type: 'BenefitCatalogueApproved',
  version: 1,
  source: 'astra.studio.catalogue',
  schema: z.object({
    catalogueId: z.uuid(),
    scheduleEditionId: z.uuid(),
    version: z.number().int(),
    benefits: z.number().int(),
    coveredReasons: z.number().int(),
    upgrades: z.number().int(),
  }),
});

export const RateManualPublished = defineEvent({
  type: 'RateManualPublished',
  version: 1,
  source: 'astra.rating.manuals',
  schema: z.object({
    manualId: z.uuid(),
    code: z.string(),
    state: z.string(),
    benefit: z.string(),
    version: z.number().int(),
    effectiveFrom: z.string(),
  }),
});

export const PlanVersionPublished = defineEvent({
  type: 'PlanVersionPublished',
  version: 1,
  source: 'astra.plans',
  schema: z.object({
    planId: z.uuid(),
    versionId: z.uuid(),
    code: z.string(),
    version: z.number().int(),
    state: z.string().nullable(),
    accountId: z.uuid().nullable(),
    effectiveFrom: z.string(),
  }),
});

export const RuleSetPublished = defineEvent({
  type: 'RuleSetPublished',
  version: 1,
  source: 'astra.underwriting',
  schema: z.object({
    ruleSetId: z.uuid(),
    planId: z.uuid(),
    version: z.number().int(),
    effectiveFrom: z.string(),
  }),
});

export const ReferralRaised = defineEvent({
  type: 'ReferralRaised',
  version: 1,
  source: 'astra.underwriting',
  schema: z.object({
    referralId: z.uuid(),
    caseRef: z.string(),
    kind: z.enum(['underwriting', 'sanctions']),
    stage: z.enum(['quote', 'bind', 'change']),
    recommendation: z.enum(['refer', 'recommend_decline']),
  }),
});

export const ReferralDecided = defineEvent({
  type: 'ReferralDecided',
  version: 1,
  source: 'astra.underwriting',
  schema: z.object({
    referralId: z.uuid(),
    caseRef: z.string(),
    decision: z.enum(['approved', 'declined']),
  }),
});

export const AgentProposalRaised = defineEvent({
  type: 'AgentProposalRaised',
  version: 1,
  source: 'astra.agents',
  schema: z.object({
    proposalId: z.uuid(),
    kind: z.enum(['variable_map', 'rate_manual', 'parity_explanation', 'document_quality', 'account_onboarding']),
    agentId: z.string(),
    subjectId: z.uuid(),
    items: z.number().int(),
  }),
});

export const AgentProposalResolved = defineEvent({
  type: 'AgentProposalResolved',
  version: 1,
  source: 'astra.agents',
  schema: z.object({
    proposalId: z.uuid(),
    kind: z.enum(['variable_map', 'rate_manual', 'parity_explanation', 'document_quality', 'account_onboarding']),
    agentId: z.string(),
    accepted: z.number().int(),
    corrected: z.number().int(),
    rejected: z.number().int(),
  }),
});

export const QuoteIssued = defineEvent({
  type: 'QuoteIssued',
  version: 1,
  source: 'astra.policies',
  schema: z.object({
    quoteId: z.uuid(),
    planCode: z.string(),
    state: z.string(),
    outcome: z.enum(['eligible', 'ineligible', 'referred', 'held']),
    total: z.string().nullable(),
  }),
});

export const PolicyBound = defineEvent({
  type: 'PolicyBound',
  version: 1,
  source: 'astra.policies',
  schema: z.object({
    policyId: z.uuid(),
    number: z.string(),
    quoteId: z.uuid(),
    planCode: z.string(),
    state: z.string(),
    premiumTotal: z.string(),
    coverageStart: z.string(),
    coverageEnd: z.string(),
  }),
});

export const DocumentTemplateReleased = defineEvent({
  type: 'DocumentTemplateReleased',
  version: 1,
  source: 'astra.documents',
  schema: z.object({ templateId: z.uuid(), planCode: z.string(), kind: z.enum(['schedule', 'policy']), version: z.number().int() }),
});

export const DocumentIssued = defineEvent({
  type: 'DocumentIssued',
  version: 1,
  source: 'astra.documents',
  schema: z.object({ documentId: z.uuid(), kind: z.string(), policyId: z.uuid().nullable(), policyNumber: z.string().nullable(), status: z.enum(['issued', 'failed']) }),
});

export const DocumentDeliveryFailed = defineEvent({
  type: 'DocumentDeliveryFailed',
  version: 1,
  source: 'astra.documents',
  schema: z.object({ deliveryId: z.uuid(), documentId: z.uuid(), channel: z.string(), reason: z.string(), attempts: z.number().int() }),
});

export const PolicyChanged = defineEvent({
  type: 'PolicyChanged',
  version: 1,
  source: 'astra.policies',
  schema: z.object({
    policyId: z.uuid(),
    number: z.string(),
    transaction: z.string(),
    premiumTotal: z.string(),
    /** Premium charged for the change, and refund due, for billing to act on. */
    charge: z.string(),
    refund: z.string(),
  }),
});

export const PolicyCancelled = defineEvent({
  type: 'PolicyCancelled',
  version: 1,
  source: 'astra.policies',
  schema: z.object({ policyId: z.uuid(), number: z.string(), refund: z.string(), basis: z.string(), reason: z.string() }),
});

export const BillingBatchCreated = defineEvent({
  type: 'BillingBatchCreated',
  version: 1,
  source: 'astra.billing',
  schema: z.object({ batchId: z.uuid(), number: z.number().int(), count: z.number().int(), premium: z.string(), commission: z.string(), tax: z.string() }),
});

export const BillingBatchConfirmed = defineEvent({
  type: 'BillingBatchConfirmed',
  version: 1,
  source: 'astra.billing',
  schema: z.object({ batchId: z.uuid(), number: z.number().int(), accepted: z.number().int(), rejected: z.number().int() }),
});

/** Raised when a batch did not go well: totals differ, billing did not answer, or it was rejected. */
export const BillingBatchFailed = defineEvent({
  type: 'BillingBatchFailed',
  version: 1,
  source: 'astra.billing',
  schema: z.object({ batchId: z.uuid(), number: z.number().int(), status: z.enum(['mismatch', 'unconfirmed', 'rejected']), reason: z.string() }),
});

/** Raised 60 and 30 days before a licence or registration expires (E07-F03-S01). */
export const LicenceExpiring = defineEvent({
  type: 'LicenceExpiring',
  version: 1,
  source: 'astra.accounts',
  schema: z.object({ accountId: z.uuid(), licenceId: z.uuid(), kind: z.string(), state: z.string(), number: z.string(), expiresOn: z.string(), daysLeft: z.number().int(), threshold: z.number().int() }),
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
  BenefitCatalogueApproved,
  RateManualPublished,
  PlanVersionPublished,
  RuleSetPublished,
  ReferralRaised,
  ReferralDecided,
  AgentProposalRaised,
  AgentProposalResolved,
  QuoteIssued,
  PolicyBound,
  DocumentTemplateReleased,
  DocumentIssued,
  DocumentDeliveryFailed,
  PolicyChanged,
  PolicyCancelled,
  BillingBatchCreated,
  BillingBatchConfirmed,
  BillingBatchFailed,
  LicenceExpiring,
] as const;

export type CatalogueEventType = (typeof EVENT_CATALOGUE)[number]['type'];
export const EVENT_TYPES = EVENT_CATALOGUE.map((e) => e.type) as CatalogueEventType[];
