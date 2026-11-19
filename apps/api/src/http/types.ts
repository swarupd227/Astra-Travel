import type { Permission } from '@astra/contracts';
import type { RequestContext } from '@astra/platform';

/**
 * Every route declares its tenancy (E13-F02-S03):
 * - `public`: no authentication (health checks, API documentation).
 * - `self`: acts only on the caller's own identity.
 * - `account`: reads or changes data that belongs to accounts. Row-level security limits results to
 *   the caller's accounts, and cross-account tests probe every such route.
 * - `platform`: staff-only, platform-wide operations. Account-scoped principals are refused.
 */
export type Tenancy = 'public' | 'self' | 'account' | 'platform';

export interface RouteMeta {
  method: string;
  url: string;
  tenancy: Tenancy;
  permission: Permission | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
  interface FastifyContextConfig {
    tenancy?: Tenancy;
    permission?: Permission;
  }
  interface FastifyInstance {
    routeCatalogue: RouteMeta[];
  }
}
