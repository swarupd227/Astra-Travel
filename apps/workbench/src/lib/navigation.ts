import type { Permission } from '@astra/contracts';

export type NavIcon =
  | 'home'
  | 'building'
  | 'webhook'
  | 'activity'
  | 'scroll'
  | 'flag'
  | 'user'
  | 'sparkles'
  | 'bot'
  | 'inbox'
  | 'card'
  | 'shield'
  | 'check'
  | 'file'
  | 'stamp'
  | 'database'
  | 'table'
  | 'calculator'
  | 'layers'
  | 'clipboard'
  | 'alert';

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  permission: Permission | null;
  description: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

/**
 * Workbench navigation. Each item names the permission it needs, and the shell only shows items the
 * signed-in user holds (E11-F01-S02). Policy modules (Studio, Rating, Policies, Card programmes and
 * so on) join this list as their increments ship.
 */
export const NAVIGATION: NavSection[] = [
  {
    label: 'Overview',
    items: [
      {
        href: '/',
        label: 'Home',
        icon: 'home',
        permission: 'workbench:access',
        description: 'Your workspace and items that need attention.',
      },
      {
        href: '/work',
        label: 'Work queue',
        icon: 'inbox',
        permission: 'tasks:read',
        description:
          'Referrals, agent work and failed deliveries waiting for a person, with timers and owners.',
      },
      {
        href: '/search',
        label: 'Find a policy',
        icon: 'file',
        permission: 'policies:read',
        description: 'Search by policy number, traveller, account or trip.',
      },
    ],
  },
  {
    label: 'Partners',
    items: [
      {
        href: '/accounts',
        label: 'Accounts',
        icon: 'building',
        permission: 'accounts:read',
        description: 'Travel sellers, card issuers and banks that sell or provide cover.',
      },
      {
        href: '/integrations/webhooks',
        label: 'Webhooks',
        icon: 'webhook',
        permission: 'webhooks:read',
        description: 'Signed event notifications sent to partner systems.',
      },
    ],
  },
  {
    label: 'Product & compliance',
    items: [
      {
        href: '/forms',
        label: 'Forms & schedules',
        icon: 'file',
        permission: 'forms:read',
        description: 'Filed forms and schedules, editions and their variable maps.',
      },
      {
        href: '/plans',
        label: 'Plans',
        icon: 'layers',
        permission: 'plans:read',
        description: 'Base, state and account plans: build, approve, test and publish.',
      },
      {
        href: '/compliance/licences',
        label: 'Licences',
        icon: 'stamp',
        permission: 'accounts:read',
        description: 'Retailer registrations and producer licences by state, with expiry alerts.',
      },
      {
        href: '/compliance/launch',
        label: 'Launch readiness',
        icon: 'check',
        permission: 'launch:read',
        description:
          'What each state still needs before it can be sold, and the go-live sign-offs.',
      },
      {
        href: '/compliance/statutory',
        label: 'Statutory data',
        icon: 'table',
        permission: 'reports:statutory',
        description:
          'Premium and policy data by state, entity and benefit, reconciled to the premium records.',
      },
      {
        href: '/compliance/filings',
        label: 'Filing register',
        icon: 'stamp',
        permission: 'filings:read',
        description: 'What is filed and approved, by state, with effective dates.',
      },
      {
        href: '/reference-data',
        label: 'Reference data',
        icon: 'database',
        permission: 'refdata:read',
        description:
          'States, countries, regions, segments, prohibited destinations and tax tables, versioned.',
      },
    ],
  },
  {
    label: 'Policies',
    items: [
      {
        href: '/quotes',
        label: 'Quotes',
        icon: 'calculator',
        permission: 'quotes:read',
        description: 'Priced and decided offers, with the versions they were made with.',
      },
      {
        href: '/policies',
        label: 'Policies',
        icon: 'file',
        permission: 'policies:read',
        description: 'One record per policy, with history and the record as it was at any date.',
      },
      {
        href: '/servicing/agent-sample',
        label: 'Agent changes',
        icon: 'clipboard',
        permission: 'servicing:review',
        description: 'A weekly random sample of the changes the servicing agent made, to review.',
      },
    ],
  },
  {
    label: 'Reports',
    items: [
      {
        href: '/reports/accounts',
        label: 'Account reports',
        icon: 'activity',
        permission: 'reports:read',
        description:
          'Sales, premium, take-up, cancellations and refunds by account, segment, state and benefit.',
      },
    ],
  },
  {
    label: 'Billing',
    items: [
      {
        href: '/billing',
        label: 'Premium records',
        icon: 'table',
        permission: 'billing:read',
        description:
          'A record for every bind, change and cancellation, with commission, tax and entity split.',
      },
      {
        href: '/billing/batches',
        label: 'Billing batches',
        icon: 'layers',
        permission: 'billing:read',
        description: 'Batches sent to the billing system, their control totals and confirmations.',
      },
      {
        href: '/billing/rules',
        label: 'Commission and programme rules',
        icon: 'stamp',
        permission: 'billing:read',
        description:
          'How each account’s commission and each card programme’s premium is calculated.',
      },
    ],
  },
  {
    label: 'Documents',
    items: [
      {
        href: '/documents',
        label: 'Document templates',
        icon: 'file',
        permission: 'documents:read',
        description:
          'Schedules and policies assembled from filed forms, checked and released by a second person.',
      },
      {
        href: '/documents/failures',
        label: 'Failed documents',
        icon: 'alert',
        permission: 'documents:read',
        description: 'Documents that could not be produced and emails that could not be delivered.',
      },
    ],
  },
  {
    label: 'Underwriting',
    items: [
      {
        href: '/underwriting/check',
        label: 'Eligibility check',
        icon: 'check',
        permission: 'underwriting:evaluate',
        description:
          'Run a case through limits, sanctions screening, duplicate cover, referral rules, the waiver and CFAR.',
      },
      {
        href: '/underwriting/plans',
        label: 'Rule sets',
        icon: 'clipboard',
        permission: 'underwriting:read',
        description: 'Plan limits and referral rules per plan, with test cases and publishing.',
      },
      {
        href: '/underwriting/referrals',
        label: 'Referrals',
        icon: 'inbox',
        permission: 'underwriting:read',
        description: 'Cases referred to an underwriter and sanctions holds to review.',
      },
      {
        href: '/underwriting/sanctions',
        label: 'Sanctions lists',
        icon: 'alert',
        permission: 'underwriting:read',
        description: 'The OFAC list used to screen travellers, with approval.',
      },
    ],
  },
  {
    label: 'Rating',
    items: [
      {
        href: '/rating/manuals',
        label: 'Rate manuals',
        icon: 'table',
        permission: 'rating:read',
        description: 'Filed manuals, their tables and formula, parity and publication.',
      },
      {
        href: '/rating/calculator',
        label: 'Rating calculator',
        icon: 'calculator',
        permission: 'rating:read',
        description: 'Rate a trip and see the full worksheet.',
      },
    ],
  },
  {
    label: 'Card-linked cover',
    items: [
      {
        href: '/card/programmes',
        label: 'Card programmes',
        icon: 'card',
        permission: 'card:read',
        description: 'Issuer programmes, eligibility feeds and the eligibility ledger.',
      },
      {
        href: '/card/master-policies',
        label: 'Master policies',
        icon: 'shield',
        permission: 'card:read',
        description: 'Group policies issued to card issuers and banks.',
      },
      {
        href: '/card/cover-check',
        label: 'Cover check',
        icon: 'check',
        permission: 'cover:verify',
        description: 'Was a cardholder covered for a trip? The answer claims staff use.',
      },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        href: '/operations/events',
        label: 'Events & deliveries',
        icon: 'activity',
        permission: 'events:read',
        description: 'Business events, delivery status and the dead-letter queue.',
      },
    ],
  },
  {
    label: 'AI agents',
    items: [
      {
        href: '/copilot',
        label: 'Copilot',
        icon: 'sparkles',
        permission: 'agents:use',
        description: 'Ask the Operations Copilot about accounts, events and the audit trail.',
      },
      {
        href: '/agents',
        label: 'Agent registry',
        icon: 'bot',
        permission: 'agents:read',
        description: 'Agents, their warrants, budgets, evaluations and kill switch.',
      },
      {
        href: '/agents/reviews',
        label: 'Agent reviews',
        icon: 'inbox',
        permission: 'agents:review',
        description: 'Work that agents routed to people.',
      },
    ],
  },
  {
    label: 'Governance',
    items: [
      {
        href: '/governance/audit',
        label: 'Audit trail',
        icon: 'scroll',
        permission: 'audit:read',
        description: 'Tamper-evident record of every change and approval.',
      },
      {
        href: '/admin/flags',
        label: 'Feature flags',
        icon: 'flag',
        permission: 'flags:read',
        description: 'Release switches, globally or per account.',
      },
    ],
  },
];

export function visibleNavigation(permissions: readonly Permission[]): NavSection[] {
  return NAVIGATION.map((s) => ({
    ...s,
    items: s.items.filter((i) => i.permission === null || permissions.includes(i.permission)),
  })).filter((s) => s.items.length > 0);
}
