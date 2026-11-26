import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { MeSchema, ProblemSchema } from '@astra/contracts';
import type { AppDeps } from '../app';

export const meRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/me',
    {
      config: { tenancy: 'self' },
      schema: {
        tags: ['Identity'],
        summary: 'The signed-in principal, its roles, permissions and account scope',
        response: { 200: MeSchema, 401: ProblemSchema },
      },
    },
    async (request) => {
      const p = request.ctx.principal;
      // Remember who has signed in, so work can be handed to them (workbench.staff). It is only a convenience:
      // a failure here never stops someone seeing who they are.
      if (p.kind === 'user') {
        await deps.pool
          .query(
            `INSERT INTO workbench.staff (subject, name, email, roles, permissions) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (subject) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, roles = EXCLUDED.roles, permissions = EXCLUDED.permissions, last_seen_at = now()
             WHERE workbench.staff.last_seen_at < now() - interval '5 minutes' OR workbench.staff.permissions IS DISTINCT FROM EXCLUDED.permissions`,
            [p.subject, p.name, p.email, p.roles, p.permissions],
          )
          .catch((err: unknown) => request.log.warn({ err }, 'could not record the signed-in person'));
      }
      return {
        subject: p.subject,
        name: p.name,
        email: p.email,
        roles: p.roles,
        permissions: p.permissions,
        accountScope: p.accountScope,
      };
    },
  );
};
