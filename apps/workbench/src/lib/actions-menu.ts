import type { Permission } from '@astra/contracts';

export interface QuickAction {
  href: string;
  label: string;
  permission: Permission;
  description: string;
}

/** Common starting points, offered on the home page and in search, to those who may do them. */
const ACTIONS: QuickAction[] = [
  {
    href: '/quotes/new',
    label: 'New quote',
    permission: 'quotes:create',
    description: 'Price a trip for a traveller.',
  },
  {
    href: '/underwriting/check',
    label: 'Check eligibility',
    permission: 'underwriting:evaluate',
    description: 'Run a case through the underwriting rules.',
  },
  {
    href: '/card/cover-check',
    label: 'Check card cover',
    permission: 'cover:verify',
    description: 'Was a cardholder covered for a trip?',
  },
  {
    href: '/rating/calculator',
    label: 'Rate a trip',
    permission: 'rating:read',
    description: 'See the premium and the full worksheet.',
  },
];

export function quickActions(permissions: readonly Permission[]): QuickAction[] {
  return ACTIONS.filter((a) => permissions.includes(a.permission));
}
