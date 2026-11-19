import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  FeatureFlagChanged,
  FeatureFlagSchema,
  SetFeatureFlagRequestSchema,
} from '@astra/contracts';
import { listFlags, notFound, publishEvent, withTx, writeAudit } from '@astra/platform';
import type { AppDeps } from '../app';
import { findAccount } from './accounts';
import { commonErrors } from './shared';

export const flagRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/feature-flags',
    {
      config: { tenancy: 'platform', permission: 'flags:read' },
      schema: {
        tags: ['Feature flags'],
        summary: 'List feature flags and their per-account overrides',
        response: { 200: z.object({ items: z.array(FeatureFlagSchema) }), ...commonErrors },
      },
    },
    async (request) => ({ items: await withTx(deps.pool, request.ctx, listFlags) }),
  );

  app.put(
    '/v1/feature-flags/:key',
    {
      config: { tenancy: 'platform', permission: 'flags:manage' },
      schema: {
        tags: ['Feature flags'],
        summary: 'Turn a feature flag on or off for every account',
        params: z.object({ key: z.string().max(100) }),
        body: SetFeatureFlagRequestSchema,
        response: { 200: FeatureFlagSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { key } = request.params;
      const { enabled, reason } = request.body;
      const flag = await withTx(deps.pool, request.ctx, async (tx) => {
        const res = await tx.query<{ enabled: boolean }>(
          `SELECT enabled FROM platform.feature_flags WHERE key = $1 FOR UPDATE`,
          [key],
        );
        const before = res.rows[0];
        if (!before) throw notFound('Feature flag');
        await tx.query(
          `UPDATE platform.feature_flags SET enabled = $2, updated_at = now(), updated_by = $3 WHERE key = $1`,
          [key, enabled, request.ctx.principal.subject],
        );
        await writeAudit(tx, request.ctx, {
          action: 'feature_flag.changed',
          resourceType: 'feature_flag',
          resourceId: key,
          reason,
          data: { from: before.enabled, to: enabled },
        });
        await publishEvent(
          tx,
          request.ctx,
          FeatureFlagChanged,
          { key, accountId: null, enabled },
          { accountId: null },
        );
        return (await listFlags(tx)).find((f) => f.key === key)!;
      });
      deps.flags.invalidate();
      return flag;
    },
  );

  app.post(
    '/v1/feature-flags/:key/overrides',
    {
      config: { tenancy: 'platform', permission: 'flags:manage' },
      schema: {
        tags: ['Feature flags'],
        summary: 'Set or clear a per-account override',
        description:
          'Send `enabled: null` to remove the override so the account follows the global value.',
        params: z.object({ key: z.string().max(100) }),
        body: z.object({
          accountId: z.uuid(),
          enabled: z.boolean().nullable(),
          reason: z.string().trim().min(3).max(500),
        }),
        response: { 200: FeatureFlagSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { key } = request.params;
      const { accountId, enabled, reason } = request.body;
      const flag = await withTx(deps.pool, request.ctx, async (tx) => {
        const exists = await tx.query(`SELECT 1 FROM platform.feature_flags WHERE key = $1`, [key]);
        if (exists.rowCount === 0) throw notFound('Feature flag');
        if (!(await findAccount(tx, accountId))) throw notFound('Account');
        const previous = await tx.query<{ enabled: boolean }>(
          `SELECT enabled FROM platform.feature_flag_overrides WHERE flag_key = $1 AND account_id = $2`,
          [key, accountId],
        );
        if (enabled === null) {
          await tx.query(
            `DELETE FROM platform.feature_flag_overrides WHERE flag_key = $1 AND account_id = $2`,
            [key, accountId],
          );
        } else {
          await tx.query(
            `INSERT INTO platform.feature_flag_overrides (flag_key, account_id, enabled, updated_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (flag_key, account_id)
             DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [key, accountId, enabled, request.ctx.principal.subject],
          );
        }
        await writeAudit(tx, request.ctx, {
          action: enabled === null ? 'feature_flag.override_removed' : 'feature_flag.override_set',
          resourceType: 'feature_flag',
          resourceId: key,
          accountId,
          reason,
          data: { from: previous.rows[0]?.enabled ?? null, to: enabled },
        });
        await publishEvent(
          tx,
          request.ctx,
          FeatureFlagChanged,
          { key, accountId, enabled },
          { accountId },
        );
        return (await listFlags(tx)).find((f) => f.key === key)!;
      });
      deps.flags.invalidate();
      return flag;
    },
  );
};
