import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { MeSchema, ProblemSchema } from '@astra/contracts';
import type { AppDeps } from '../app';

export const meRoutes: FastifyPluginAsyncZod<AppDeps> = async (app) => {
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
