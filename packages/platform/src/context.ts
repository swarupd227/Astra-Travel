import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS, type AccountScope, type Permission, type Role } from '@astra/contracts';

/** Who is acting. People, partner systems, agents and the platform itself are all principals. */
export interface Principal {
  kind: 'user' | 'partner' | 'agent' | 'system';
  subject: string;
  name: string | null;
  email: string | null;
  roles: Role[];
  permissions: Permission[];
  accountScope: AccountScope;
}

export interface RequestContext {
  correlationId: string;
  principal: Principal;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function tryCurrentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('No request context is active');
  return ctx;
}

export function systemPrincipal(component: string): Principal {
  return {
    kind: 'system',
    subject: `system:${component}`,
    name: component,
    email: null,
    roles: [],
    permissions: [...ALL_PERMISSIONS],
    accountScope: { type: 'all' },
  };
}

export function systemContext(component: string, correlationId?: string): RequestContext {
  return { correlationId: correlationId ?? randomUUID(), principal: systemPrincipal(component) };
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

export function canSeeAccount(principal: Principal, accountId: string): boolean {
  return (
    principal.accountScope.type === 'all' || principal.accountScope.accountIds.includes(accountId)
  );
}

/** The value written to the `app.account_ids` database setting that row-level security reads. */
export function accountScopeSetting(scope: AccountScope): string {
  if (scope.type === 'all') return '*';
  return scope.accountIds.join(',');
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Accepts a caller-supplied correlation ID only if it is safe to log and propagate. */
export function normaliseCorrelationId(value: unknown): string {
  return typeof value === 'string' && CORRELATION_ID.test(value) ? value : randomUUID();
}
