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
  | 'database';

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
