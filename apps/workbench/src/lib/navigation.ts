import type { Permission, Role } from '@astra/contracts';

export type NavIcon =
  | 'home'
  | 'inbox'
  | 'policies'
  | 'sales'
  | 'underwriting'
  | 'products'
  | 'partners'
  | 'card'
  | 'billing'
  | 'compliance'
  | 'agents'
  | 'operations';

export interface NavItem {
  href: string;
  label: string;
  permission: Permission | null;
  description: string;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: NavIcon;
  items: NavItem[];
}

/** The three places everyone starts from. They sit above the groups and are always visible. */
export const PRIMARY: (NavItem & { icon: NavIcon })[] = [
  {
    href: '/',
    label: 'Home',
    icon: 'home',
    permission: 'workbench:access',
    description: 'Your day at a glance and the work that needs attention.',
  },
  {
    href: '/work',
    label: 'Work queue',
    icon: 'inbox',
    permission: 'tasks:read',
    description: 'Referrals, agent work and failed deliveries waiting for a person.',
  },
  {
    href: '/policies',
    label: 'Policies',
    icon: 'policies',
    permission: 'policies:read',
    description: 'Find a policy by number, traveller, account or trip.',
  },
];

/**
 * Workbench navigation, grouped by the job being done. Each item names the permission it needs, and
 * the shell only shows items the signed-in user holds (E11-F01-S02).
 */
export const NAVIGATION: NavGroup[] = [
  {
    id: 'sales',
    label: 'Quotes & servicing',
    icon: 'sales',
    items: [
      {
        href: '/quotes',
        label: 'Quotes',
        permission: 'quotes:read',
        description: 'Priced and decided offers.',
      },
      {
        href: '/servicing/agent-sample',
        label: 'Agent changes',
        permission: 'servicing:review',
        description: 'A weekly sample of the changes the servicing agent made, to review.',
      },
      {
        href: '/documents/failures',
        label: 'Failed documents',
        permission: 'documents:read',
        description: 'Documents that could not be produced and emails that were not delivered.',
      },
    ],
  },
  {
    id: 'underwriting',
    label: 'Underwriting',
    icon: 'underwriting',
    items: [
      {
        href: '/underwriting/referrals',
        label: 'Referrals',
        permission: 'underwriting:read',
        description: 'Cases referred to an underwriter and sanctions holds to review.',
      },
      {
        href: '/underwriting/check',
        label: 'Eligibility check',
        permission: 'underwriting:evaluate',
        description: 'Check a case against limits, sanctions, duplicate cover and referral rules.',
      },
      {
        href: '/underwriting/plans',
        label: 'Rule sets',
        permission: 'underwriting:read',
        description: 'Plan limits and referral rules, with test cases and publishing.',
      },
      {
        href: '/underwriting/sanctions',
        label: 'Sanctions lists',
        permission: 'underwriting:read',
        description: 'The OFAC list used to screen travellers.',
      },
    ],
  },
  {
    id: 'products',
    label: 'Products & rating',
    icon: 'products',
    items: [
      {
        href: '/plans',
        label: 'Plans',
        permission: 'plans:read',
        description: 'Build, approve, test and publish base, state and account plans.',
      },
      {
        href: '/forms',
        label: 'Forms & schedules',
        permission: 'forms:read',
        description: 'Filed forms and schedules, their editions and variable maps.',
      },
      {
        href: '/documents',
        label: 'Document templates',
        permission: 'documents:read',
        description: 'Schedules and policies assembled from filed forms.',
      },
      {
        href: '/rating/manuals',
        label: 'Rate manuals',
        permission: 'rating:read',
        description: 'Filed manuals, their tables and formula.',
      },
      {
        href: '/rating/calculator',
        label: 'Rating calculator',
        permission: 'rating:read',
        description: 'Rate a trip and see the full worksheet.',
      },
      {
        href: '/reference-data',
        label: 'Reference data',
        permission: 'refdata:read',
        description: 'States, countries, regions, segments, destinations and tax tables.',
      },
    ],
  },
  {
    id: 'partners',
    label: 'Partners',
    icon: 'partners',
    items: [
      {
        href: '/accounts',
        label: 'Accounts',
        permission: 'accounts:read',
        description: 'Travel sellers, card issuers and banks that sell or provide cover.',
      },
      {
        href: '/channels/booking-files',
        label: 'Booking files',
        permission: 'quotes:create',
        description: 'Send a file of bookings and download its result.',
      },
      {
        href: '/integrations/webhooks',
        label: 'Webhooks',
        permission: 'webhooks:read',
        description: 'Signed event notifications sent to partner systems.',
      },
    ],
  },
  {
    id: 'card',
    label: 'Card cover',
    icon: 'card',
    items: [
      {
        href: '/card/programmes',
        label: 'Card programmes',
        permission: 'card:read',
        description: 'Issuer programmes and their eligibility feeds.',
      },
      {
        href: '/card/master-policies',
        label: 'Master policies',
        permission: 'card:read',
        description: 'Group policies issued to card issuers and banks.',
      },
      {
        href: '/card/cover-check',
        label: 'Cover check',
        permission: 'cover:verify',
        description: 'Was a cardholder covered for a trip?',
      },
    ],
  },
  {
    id: 'billing',
    label: 'Billing & reports',
    icon: 'billing',
    items: [
      {
        href: '/billing',
        label: 'Premium records',
        permission: 'billing:read',
        description: 'A record for every purchase, change and cancellation.',
      },
      {
        href: '/billing/batches',
        label: 'Billing batches',
        permission: 'billing:read',
        description: 'Batches sent to the billing system and their confirmations.',
      },
      {
        href: '/billing/rules',
        label: 'Commission and programme rules',
        permission: 'billing:read',
        description: 'How commission and card programme premium are calculated.',
      },
      {
        href: '/reports/accounts',
        label: 'Account reports',
        permission: 'reports:read',
        description: 'Sales, premium, take-up, cancellations and refunds.',
      },
      {
        href: '/compliance/statutory',
        label: 'Statutory data',
        permission: 'reports:statutory',
        description: 'Premium and policy data by state, entity and benefit.',
      },
    ],
  },
  {
    id: 'compliance',
    label: 'Compliance',
    icon: 'compliance',
    items: [
      {
        href: '/compliance/filings',
        label: 'Filing register',
        permission: 'filings:read',
        description: 'What is filed and approved in each state.',
      },
      {
        href: '/compliance/licences',
        label: 'Licences',
        permission: 'accounts:read',
        description: 'Retailer registrations and producer licences, with expiry alerts.',
      },
      {
        href: '/compliance/launch',
        label: 'Launch readiness',
        permission: 'launch:read',
        description: 'What each state needs before it can be sold.',
      },
      {
        href: '/governance/audit',
        label: 'Audit trail',
        permission: 'audit:read',
        description: 'Tamper-evident record of every change and approval.',
      },
    ],
  },
  {
    id: 'agents',
    label: 'AI agents',
    icon: 'agents',
    items: [
      {
        href: '/copilot',
        label: 'Copilot',
        permission: 'agents:use',
        description: 'Ask about accounts, events and the audit trail.',
      },
      {
        href: '/agents',
        label: 'Agent registry',
        permission: 'agents:read',
        description: 'What each agent may do, its budget, tests and stop switch.',
      },
      {
        href: '/agents/reviews',
        label: 'Agent reviews',
        permission: 'agents:review',
        description: 'Work that agents passed to people.',
      },
    ],
  },
  {
    id: 'operations',
    label: 'Operations & settings',
    icon: 'operations',
    items: [
      {
        href: '/operations/events',
        label: 'Events & deliveries',
        permission: 'events:read',
        description: 'Business events and whether partners received them.',
      },
      {
        href: '/admin/flags',
        label: 'Feature flags',
        permission: 'flags:read',
        description: 'Release switches, globally or per account.',
      },
      {
        href: '/admin/model',
        label: 'AI model connection',
        permission: 'settings:manage',
        description: 'The key the AI agents use to call the model.',
      },
    ],
  },
];

/** The groups each role works in most. They start open; the rest start closed. */
const ROLE_GROUPS: Partial<Record<Role, string[]>> = {
  product_manager: ['products'],
  rating_analyst: ['products'],
  underwriter: ['underwriting', 'sales'],
  account_manager: ['partners', 'sales'],
  service_rep: ['sales', 'card'],
  finance_analyst: ['billing'],
  card_programme_manager: ['card'],
  compliance_officer: ['compliance'],
  ops_supervisor: ['sales', 'operations'],
  ai_governance_lead: ['agents'],
  platform_admin: ['sales'],
};

export function homeGroups(roles: readonly Role[]): string[] {
  return [...new Set(roles.flatMap((r) => ROLE_GROUPS[r] ?? []))];
}

export interface VisibleNavigation {
  primary: (NavItem & { icon: NavIcon })[];
  groups: NavGroup[];
}

export function visibleNavigation(permissions: readonly Permission[]): VisibleNavigation {
  const allowed = (i: NavItem) => i.permission === null || permissions.includes(i.permission);
  return {
    primary: PRIMARY.filter(allowed),
    groups: NAVIGATION.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter(
      (g) => g.items.length > 0,
    ),
  };
}
