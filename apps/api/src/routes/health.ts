import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../app';

export const healthRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/health/live',
    {
      config: { tenancy: 'public' },
      schema: { hide: true, response: { 200: z.object({ status: z.literal('ok') }) } },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      config: { tenancy: 'public' },
      schema: {
        hide: true,
        response: {
          200: z.object({ status: z.literal('ready') }),
          503: z.object({ status: z.literal('unavailable'), reason: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      try {
        await deps.pool.query('SELECT 1');
        return { status: 'ready' as const };
      } catch {
        return reply.code(503).send({ status: 'unavailable' as const, reason: 'database' });
      }
    },
  );
};
