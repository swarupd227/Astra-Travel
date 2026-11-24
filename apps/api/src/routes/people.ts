import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { namesFor } from '@astra/platform';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';

/** Display names for the subjects shown on staff screens (who loaded, approved, received...). */
export const peopleRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/people',
    {
      config: { tenancy: 'platform', permission: 'workbench:access' },
      schema: {
        tags: ['Identity'],
        summary: 'Display names for up to 200 subjects',
        querystring: z.object({
          subject: z.union([
            z.string().min(1).max(255),
            z.array(z.string().min(1).max(255)).max(200),
          ]),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                subject: z.string(),
                name: z.string(),
                kind: z.enum(['user', 'partner', 'system', 'agent', 'unknown']),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const s = request.query.subject;
      return { items: await namesFor(deps.pool, Array.isArray(s) ? s : [s]) };
    },
  );
};
