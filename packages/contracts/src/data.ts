import { z } from 'zod';

/**
 * Increment 16b: the reporting data model and its catalogue (E12-F01-S01), loads to the data platform (E12-F01-S02)
 * and the claims feed (E12-F01-S03, E14-F03-S04). Design: docs/adr/0018.
 *
 * The specification asks for the model on the Artizent P&C ontology, which has not been supplied: the names here are
 * the platform's own and each definition says what it means, ready to be mapped.
 */

export interface DataField {
  name: string;
  type: 'uuid' | 'text' | 'integer' | 'decimal' | 'date' | 'timestamp' | 'boolean' | 'json';
  required: boolean;
  /** Personal data is left out of the data platform loads. */
  classification: 'business' | 'personal';
  description: string;
}

export interface DataEntity {
  name: 'plans' | 'accounts' | 'policies' | 'travellers' | 'trips' | 'benefits' | 'premiums' | 'transactions';
  description: string;
  key: string[];
  fields: DataField[];
}

const f = (name: string, type: DataField['type'], description: string, opts: { optional?: boolean; personal?: boolean } = {}): DataField => ({
  name,
  type,
  required: !opts.optional,
  classification: opts.personal ? 'personal' : 'business',
  description,
});

export const DATA_CATALOGUE_VERSION = 1;

export const DATA_CATALOGUE: readonly DataEntity[] = [
  {
    name: 'plans',
    description: 'An insurance plan: the base form, a state’s plan, or an account’s plan.',
    key: ['plan_id'],
    fields: [
      f('plan_id', 'uuid', 'Identifier of the plan.'),
      f('code', 'text', 'The code the plan is quoted by.'),
      f('name', 'text', 'The plan’s name.'),
      f('kind', 'text', 'base, state or account.'),
      f('term', 'text', 'single_trip or annual.'),
      f('state', 'text', 'The state it is filed for; empty for a base plan.', { optional: true }),
      f('account_id', 'uuid', 'The account it belongs to; only for an account plan.', { optional: true }),
    ],
  },
  {
    name: 'accounts',
    description: 'A travel seller, card issuer or bank that sells or provides cover.',
    key: ['account_id'],
    fields: [
      f('account_id', 'uuid', 'Identifier of the account.'),
      f('code', 'text', 'The account’s code.'),
      f('name', 'text', 'The account’s name.'),
      f('kind', 'text', 'travel_account, card_issuer or bank.'),
      f('status', 'text', 'onboarding, active, suspended or closed.'),
      f('sandbox', 'boolean', 'True for a test twin: its transactions are synthetic.'),
    ],
  },
  {
    name: 'policies',
    description: 'One retail policy as it stands now.',
    key: ['policy_id'],
    fields: [
      f('policy_id', 'uuid', 'Identifier of the policy.'),
      f('policy_number', 'text', 'The number the traveller holds.'),
      f('account_id', 'uuid', 'The account that sold it.'),
      f('plan_id', 'uuid', 'The plan.'),
      f('plan_version', 'integer', 'The plan version it was bound with.'),
      f('state', 'text', 'The state it was sold in.'),
      f('status', 'text', 'active, cancelled or expired.'),
      f('purchased_on', 'date', 'The date it was bought.'),
      f('term_start', 'timestamp', 'When cover starts, local time of the policy.'),
      f('term_end', 'timestamp', 'When cover ends, local time of the policy.'),
      f('premium_total', 'decimal', 'The premium now, in US dollars.'),
    ],
  },
  {
    name: 'travellers',
    description: 'A person covered by a policy.',
    key: ['policy_id', 'traveller_id'],
    fields: [
      f('policy_id', 'uuid', 'The policy.'),
      f('traveller_id', 'text', 'The traveller within the policy.'),
      f('account_id', 'uuid', 'The account.'),
      f('first_name', 'text', 'Given name.', { personal: true }),
      f('last_name', 'text', 'Family name.', { personal: true }),
      f('date_of_birth', 'date', 'Date of birth.', { optional: true, personal: true }),
    ],
  },
  {
    name: 'trips',
    description: 'The trip a policy covers, as it stands now.',
    key: ['policy_id'],
    fields: [
      f('policy_id', 'uuid', 'The policy.'),
      f('account_id', 'uuid', 'The account.'),
      f('departure_date', 'date', 'Departure date.'),
      f('return_date', 'date', 'Return date.'),
      f('initial_deposit_date', 'date', 'Date of the first trip payment.', { optional: true }),
      f('destinations', 'json', 'Destinations: country code and region.'),
    ],
  },
  {
    name: 'benefits',
    description: 'A benefit on a policy with its limits and cover dates.',
    key: ['policy_id', 'benefit_code'],
    fields: [
      f('policy_id', 'uuid', 'The policy.'),
      f('benefit_code', 'text', 'The benefit.'),
      f('account_id', 'uuid', 'The account.'),
      f('name', 'text', 'The benefit’s filed name.'),
      f('benefit_group', 'text', 'The group it belongs to.'),
      f('underwriter', 'text', 'The underwriting arrangement.', { optional: true }),
      f('limits', 'json', 'The limits that apply.'),
      f('premium', 'decimal', 'Premium for the benefit; empty when it is not priced separately.', { optional: true }),
      f('coverage_start', 'timestamp', 'When this benefit starts.'),
      f('coverage_end', 'timestamp', 'When this benefit ends.'),
    ],
  },
  {
    name: 'premiums',
    description: 'A premium record: money charged or refunded by one transaction, or a card programme’s premium for a month.',
    key: ['premium_id'],
    fields: [
      f('premium_id', 'uuid', 'Identifier of the record.'),
      f('record_number', 'text', 'Billing record number.'),
      f('type', 'text', 'bind, change, cancellation or programme.'),
      f('account_id', 'uuid', 'The account.'),
      f('policy_id', 'uuid', 'The policy; empty for a card programme.', { optional: true }),
      f('transaction_id', 'integer', 'The policy transaction that moved the money; empty for a card programme.', { optional: true }),
      f('state', 'text', 'State; empty for a card programme.', { optional: true }),
      f('status', 'text', 'held, ready, batched, sent, confirmed or rejected by billing.'),
      f('premium', 'decimal', 'Charge less refund.'),
      f('charge', 'decimal', 'Amount charged.'),
      f('refund', 'decimal', 'Amount refunded.'),
      f('tax', 'decimal', 'Premium tax; empty while a rate is missing.', { optional: true }),
      f('commission', 'decimal', 'Commission; empty while it cannot be worked out.', { optional: true }),
      f('per_benefit', 'json', 'Premium by benefit.'),
      f('allocation', 'json', 'Premium and tax by underwriting entity.'),
      f('occurred_at', 'timestamp', 'When the money moved.'),
    ],
  },
  {
    name: 'transactions',
    description: 'A change to a policy: bind, change, correction or cancellation.',
    key: ['transaction_id'],
    fields: [
      f('transaction_id', 'integer', 'Order of the change.'),
      f('policy_id', 'uuid', 'The policy.'),
      f('account_id', 'uuid', 'The account.'),
      f('transaction_type', 'text', 'bind, cancel, correct or the kind of change.'),
      f('occurred_at', 'timestamp', 'When it happened.'),
    ],
  },
];

export const DataCatalogueSchema = z.object({
  version: z.number().int(),
  ontology: z.string(),
  entities: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      key: z.array(z.string()),
      fields: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean(), classification: z.enum(['business', 'personal']), description: z.string() })),
    }),
  ),
});

export const DataLoadSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  startedAt: z.iso.datetime(),
  status: z.enum(['delivered', 'with_rejects']),
  trigger: z.enum(['schedule', 'manual']),
  items: z.number().int(),
  rejected: z.number().int(),
  maxLagSeconds: z.number().int(),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
  files: z.array(z.object({ name: z.string(), rows: z.number().int(), sha256: z.string(), bytes: z.number().int() })),
});
export type DataLoad = z.infer<typeof DataLoadSchema>;

export const DataLoadStatusSchema = z.object({
  items: z.array(DataLoadSchema),
  /** Changes not yet loaded, and whether the 15-minute target is being met. */
  pending: z.object({ count: z.number().int(), oldestSeconds: z.number().int().nullable(), withinTarget: z.boolean() }),
  targetSeconds: z.number().int(),
  /** Where loads are delivered. No data platform connection has been supplied, so they are files in the platform's store. */
  destination: z.string(),
});

export const ClaimsPolicySchema = z.object({
  policyNumber: z.string(),
  /** Rises with every change to the policy: keep the highest version seen for a policy number. */
  version: z.number().int(),
  status: z.enum(['active', 'cancelled', 'expired']),
  accountId: z.uuid(),
  accountName: z.string(),
  planCode: z.string(),
  planVersion: z.number().int(),
  state: z.string(),
  purchasedOn: z.string(),
  coverageStart: z.string(),
  coverageEnd: z.string(),
  travellers: z.array(z.object({ travellerId: z.string(), firstName: z.string(), lastName: z.string(), dateOfBirth: z.string().nullable() })),
  trip: z.object({ departureDate: z.string().nullable(), returnDate: z.string().nullable(), destinations: z.array(z.object({ country: z.string().nullable(), region: z.string().nullable() })) }),
  benefits: z.array(z.object({ code: z.string(), name: z.string(), limits: z.unknown(), coverageStart: z.string(), coverageEnd: z.string() })),
});

export const ClaimsCertificateSchema = z.object({
  certificateNumber: z.string(),
  programmeCode: z.string(),
  programmeName: z.string(),
  accountId: z.uuid(),
  masterPolicyNumber: z.string(),
  underwriter: z.string(),
  states: z.array(z.string()),
  /** The issuer's reference for the cardholder; the platform holds no cardholder names or card numbers. */
  cardholderRef: z.string(),
  issuedAt: z.iso.datetime(),
  /** When the cardholder was eligible, from the issuer's feeds. */
  eligibility: z.array(z.object({ productCode: z.string(), from: z.string(), to: z.string().nullable() })),
  /** The Guide to Benefits in force, which sets the benefits and limits of a card programme. */
  guideDocumentId: z.uuid().nullable(),
});

export const ClaimsFeedSchema = z.object({
  format: z.literal('astra.claims.v1'),
  generatedAt: z.iso.datetime(),
  policies: z.array(ClaimsPolicySchema),
  certificates: z.array(ClaimsCertificateSchema),
  /** Pass these back to get what changed since. */
  next: z.object({ policyCursor: z.number().int(), certificateCursor: z.string(), more: z.boolean() }),
});
export type ClaimsFeed = z.infer<typeof ClaimsFeedSchema>;
