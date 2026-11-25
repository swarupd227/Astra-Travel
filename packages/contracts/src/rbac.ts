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

/**
 * Roles held by Assurant systems rather than people (client-credentials clients). They act platform-wide
 * but only within their permissions, and are audited as `system` actors.
 */
export const SYSTEM_ROLES = ['cover_verifier'] as const;

export const ROLES = [...STAFF_ROLES, ...EXTERNAL_ROLES, ...SYSTEM_ROLES] as const;
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
  cover_verifier: 'Cover verification system (claims)',
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
  'card:read': 'View card programmes, master policies, feeds and eligibility',
  'card:manage': 'Set up card programmes and master policies and take them live',
  'card:feeds': 'Load issuer eligibility feeds and reject held feeds',
  'cover:verify': 'Check whether a cardholder or traveller was covered on a date',
  'refdata:read': 'View reference data and its versions',
  'refdata:manage': 'Load reference data versions, and approve versions loaded by someone else',
  'filings:read': 'View the filing register',
  'filings:manage': 'Record filings and their status by state',
  'forms:read': 'View filed forms, schedules and their variable maps',
  'forms:manage': 'Load form editions and edit or approve variable maps',
  'rating:read': 'View rate manuals, parity results and rating worksheets, and rate trips',
  'rating:manage': 'Load rate manuals and parity cases',
  'rating:approve': 'Approve rate manuals loaded by someone else and publish them',
  'plans:read': 'View plans, their versions, comparisons and test results',
  'plans:manage': 'Build plans, state variants and account plans, and their test cases',
  'plans:approve': 'Approve plan versions built by someone else and publish them',
  'underwriting:read': 'View rule sets, sanctions lists and referrals',
  'underwriting:evaluate': 'Evaluate eligibility, record declarations and screen travellers',
  'underwriting:manage': 'Build rule sets and their test cases and load sanctions lists',
  'underwriting:approve': 'Approve rule sets and sanctions lists loaded by someone else and publish rule sets',
  'referrals:decide': 'Decide referrals and sanctions holds',
  'proposals:read': 'View what agents have proposed for forms, manuals and parity',
  'proposals:create': 'Submit proposals for forms, manuals and parity (used by agents acting for a person)',
  'quotes:create': 'Create quotes, change their selections and bind them to policies',
  'quotes:read': 'View quotes',
  'policies:read': 'View policies, their history and their record at any date',
  'servicing:execute': 'Preview and make changes, cancellations and corrections on policies',
  'servicing:review': 'Review the sample of changes made by the servicing agent',
  'documents:read': 'View document templates, issued documents and their delivery',
  'documents:manage': 'Assemble document templates, issue notices and guides, and retry failed deliveries',
  'documents:release': 'Release document templates assembled by someone else, and resolve document quality findings',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const STAFF_BASE: Permission[] = [
  'workbench:access',
  'accounts:read',
  'flags:read',
  'agents:use',
  'refdata:read',
  'filings:read',
  'forms:read',
  'rating:read',
  'plans:read',
  'underwriting:read',
  'proposals:read',
  'quotes:read',
  'policies:read',
  'documents:read',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  product_manager: [...STAFF_BASE, 'forms:manage', 'plans:manage', 'plans:approve', 'proposals:create', 'documents:manage'],
  rating_analyst: [
    ...STAFF_BASE,
    'forms:manage',
    'refdata:manage',
    'rating:manage',
    'rating:approve',
    'proposals:create',
  ],
  underwriter: [...STAFF_BASE, 'card:read', 'underwriting:evaluate', 'underwriting:manage', 'underwriting:approve', 'referrals:decide'],
  account_manager: [
    ...STAFF_BASE,
    'accounts:manage',
    'webhooks:read',
    'webhooks:manage',
    'card:read',
    'quotes:create',
    'servicing:execute',
  ],
  service_rep: [...STAFF_BASE, 'card:read', 'cover:verify', 'quotes:create', 'servicing:execute'],
  finance_analyst: [...STAFF_BASE, 'card:read'],
  card_programme_manager: [
    ...STAFF_BASE,
    'webhooks:read',
    'card:read',
    'card:manage',
    'card:feeds',
    'cover:verify',
    'documents:manage',
  ],
  compliance_officer: [
    ...STAFF_BASE,
    'audit:read',
    'audit:verify',
    'events:read',
    'agents:read',
    'card:read',
    'filings:manage',
    'forms:manage',
    'refdata:manage',
    'rating:approve',
    'plans:approve',
    'underwriting:evaluate',
    'underwriting:manage',
    'underwriting:approve',
    'referrals:decide',
    'documents:manage',
    'documents:release',
    'proposals:create',
  ],
  ops_supervisor: [
    ...STAFF_BASE,
    'documents:manage',
    'events:read',
    'events:replay',
    'webhooks:read',
    'agents:read',
    'agents:pause',
    'agents:review',
    'servicing:review',
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
  // Issuers deliver eligibility feeds for their own programmes through the API (E21-F02-S01).
  partner_developer: [
    'accounts:read',
    'webhooks:read',
    'webhooks:manage',
    'card:read',
    'card:feeds',
    'quotes:create',
    'quotes:read',
    'policies:read',
    'documents:read',
    'servicing:execute',
  ],
  cover_verifier: ['cover:verify'],
};

export function isSystemRole(role: Role): boolean {
  return (SYSTEM_ROLES as readonly string[]).includes(role);
}

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
