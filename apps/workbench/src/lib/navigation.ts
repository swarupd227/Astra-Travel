import type { Permission } from '@astra/contracts';

export type NavIcon = 'home' | 'building' | 'webhook' | 'activity' | 'scroll' | 'flag' | 'user';

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
