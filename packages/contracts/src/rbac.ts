/**
 * Roles and permissions (E11-F01-S02, E13-F02-S02).
 *
 * Roles follow specification section 6. Identity-provider groups are mapped to roles by the API
 * (group name `astra-<role-with-dashes>` by default, or an explicit map for Entra ID group object IDs).
 * The permission matrix is the single source of truth for both API authorisation and workbench screens.
 */

export const STAFF_ROLES = [
  'product_manager',
  'rating_analyst',
  'underwriter',
  'account_manager',
  'service_rep',
  'finance_analyst',
  'card_programme_manager',
  'compliance_officer',
  'ops_supervisor',
  'ai_governance_lead',
  'platform_admin',
] as const;

export const EXTERNAL_ROLES = ['partner_developer'] as const;

export const ROLES = [...STAFF_ROLES, ...EXTERNAL_ROLES] as const;
export type Role = (typeof ROLES)[number];
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  product_manager: 'Product manager',
  rating_analyst: 'Rating analyst',
  underwriter: 'Underwriter',
  account_manager: 'Account manager',
  service_rep: 'Policy service representative',
  finance_analyst: 'Premium accounting and finance',
  card_programme_manager: 'Card programme manager',
  compliance_officer: 'Compliance officer',
  ops_supervisor: 'Operations supervisor',
  ai_governance_lead: 'AI governance lead',
  platform_admin: 'Platform administrator',
  partner_developer: 'Account integration developer',
};

export const PERMISSIONS = {
  'workbench:access': 'Sign in to the operations workbench',
  'accounts:read': 'View accounts',
  'accounts:manage': 'Register accounts and change their status',
  'webhooks:read': 'View webhook subscriptions',
  'webhooks:manage': 'Create, pause and remove webhook subscriptions',
  'events:read': 'View business events and their delivery status',
  'events:replay': 'Replay dead-lettered event deliveries',
  'audit:read': 'View the audit trail',
  'audit:verify': 'Run audit-trail integrity verification',
  'flags:read': 'View feature flags',
  'flags:manage': 'Change feature flags',
  'agents:use': 'Ask AI agents for help within your own access',
  'agents:read': 'View AI agents, their warrants, runs and evaluations',
  'agents:manage': 'Approve agent versions and set warrants, budgets and evaluations',
  'agents:pause': 'Pause or resume an AI agent (kill switch)',
  'agents:review': 'Review and resolve work routed from AI agents',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const STAFF_BASE: Permission[] = ['workbench:access', 'accounts:read', 'flags:read', 'agents:use'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  product_manager: [...STAFF_BASE],
  rating_analyst: [...STAFF_BASE],
  underwriter: [...STAFF_BASE],
  account_manager: [...STAFF_BASE, 'accounts:manage', 'webhooks:read', 'webhooks:manage'],
  service_rep: [...STAFF_BASE],
  finance_analyst: [...STAFF_BASE],
  card_programme_manager: [...STAFF_BASE, 'webhooks:read'],
  compliance_officer: [...STAFF_BASE, 'audit:read', 'audit:verify', 'events:read', 'agents:read'],
  ops_supervisor: [
    ...STAFF_BASE,
    'events:read',
    'events:replay',
    'webhooks:read',
    'agents:read',
    'agents:pause',
    'agents:review',
  ],
  ai_governance_lead: [
    ...STAFF_BASE,
    'audit:read',
    'agents:read',
    'agents:manage',
    'agents:pause',
    'agents:review',
  ],
  platform_admin: [...ALL_PERMISSIONS],
  partner_developer: ['accounts:read', 'webhooks:read', 'webhooks:manage'],
};

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role]) set.add(p);
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isStaffRole(role: Role): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

/** Default identity-provider group name for a role, e.g. `astra-platform-admin`. */
export function defaultGroupForRole(role: Role): string {
  return `astra-${role.replace(/_/g, '-')}`;
}
