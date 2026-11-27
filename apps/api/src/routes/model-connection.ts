import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  ModelConnectionSchema,
  ModelConnectionTestSchema,
  RemoveModelKeyRequestSchema,
  SaveModelKeyRequestSchema,
  TestModelConnectionRequestSchema,
  type ModelConnection,
  type ModelTestOutcome,
} from '@astra/contracts';
import { AppError, notFound, withTx, writeAudit, type Tx } from '@astra/platform';
import { AGENT_MANIFESTS, credentialAad, savedModelKey, testModelConnection } from '@astra/agents';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';

const agentModels = () => [...new Set(AGENT_MANIFESTS.map((m) => m.model))].sort();

async function readConnection(tx: Tx): Promise<ModelConnection> {
  const { rows } = await tx.query<{
    id: string;
    hint: string;
    set_at: Date;
    set_by: string;
    set_by_name: string | null;
    set_reason: string;
  }>(
    `SELECT id, hint, set_at, set_by, set_by_name, set_reason
       FROM platform.model_credentials WHERE removed_at IS NULL`,
  );
  const saved = rows[0];
  const tests = saved
    ? await tx.query<{
        ok: boolean;
        outcome: ModelTestOutcome;
        message: string;
        models: { model: string; ok: boolean }[];
        latency_ms: number;
        tested_at: Date;
        tested_by: string;
        tested_by_name: string | null;
      }>(
        `SELECT ok, outcome, message, models, latency_ms, tested_at, tested_by, tested_by_name
           FROM platform.model_connection_tests WHERE credential_id = $1
          ORDER BY tested_at DESC LIMIT 1`,
        [saved.id],
      )
    : undefined;
  const test = tests?.rows[0];
  return {
    provider: 'anthropic',
    savedKey: saved
      ? {
          endsWith: saved.hint,
          savedAt: saved.set_at.toISOString(),
          savedBy: saved.set_by_name ?? saved.set_by,
          reason: saved.set_reason,
        }
      : null,
    models: agentModels(),
    lastTest: test
      ? {
          ok: test.ok,
          source: 'saved',
          outcome: test.outcome,
          message: test.message,
          models: test.models,
          latencyMs: test.latency_ms,
          testedAt: test.tested_at.toISOString(),
          testedBy: test.tested_by_name ?? test.tested_by,
        }
      : null,
  };
}

export const modelConnectionRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // Only a person sets or uses the key: never an agent or another system, whatever it was granted.
  app.addHook('preHandler', async (request) => {
    if (request.ctx.principal.kind !== 'user') {
      throw new AppError('forbidden', 'The model connection is managed by a person.');
    }
  });

  app.get(
    '/v1/settings/model-connection',
    {
      config: { tenancy: 'platform', permission: 'settings:manage' },
      schema: {
        tags: ['Settings'],
        summary: 'The model connection: whether a key is saved and how its last test went',
        response: { 200: ModelConnectionSchema, ...commonErrors },
      },
    },
    async (request) => withTx(deps.pool, request.ctx, readConnection),
  );

  app.put(
    '/v1/settings/model-connection/key',
    {
      config: { tenancy: 'platform', permission: 'settings:manage' },
      schema: {
        tags: ['Settings'],
        summary: 'Save the model API key, replacing any saved one',
        description: 'The key is stored encrypted and is never returned.',
        body: SaveModelKeyRequestSchema,
        response: { 200: ModelConnectionSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { apiKey, reason } = request.body;
      const id = randomUUID();
      const sealed = deps.secrets.seal(apiKey, credentialAad(id));
      const endsWith = apiKey.slice(-4);
      const { principal } = request.ctx;
      return withTx(deps.pool, request.ctx, async (tx) => {
        // One change at a time, so two saves cannot both leave a key in force.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('platform.model_credentials'))`);
        const replaced = await tx.query<{ id: string }>(
          `UPDATE platform.model_credentials
              SET removed_at = now(), removed_by = $1, removed_reason = $2, ciphertext = NULL
            WHERE removed_at IS NULL RETURNING id`,
          [principal.subject, 'Replaced by a new key'],
        );
        await tx.query(
          `INSERT INTO platform.model_credentials
             (id, ciphertext, key_id, hint, set_by, set_by_name, set_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            sealed.ciphertext,
            sealed.keyId,
            endsWith,
            principal.subject,
            principal.name,
            reason,
          ],
        );
        await writeAudit(tx, request.ctx, {
          action: 'model_key.saved',
          resourceType: 'model_credential',
          resourceId: id,
          reason,
          data: { endsWith, replaced: replaced.rows[0]?.id ?? null },
        });
        return readConnection(tx);
      });
    },
  );

  app.post(
    '/v1/settings/model-connection/key/removal',
    {
      config: { tenancy: 'platform', permission: 'settings:manage' },
      schema: {
        tags: ['Settings'],
        summary: 'Remove the saved model API key',
        description: 'The encrypted key is erased. The record of who saved and removed it is kept.',
        body: RemoveModelKeyRequestSchema,
        response: { 200: ModelConnectionSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { reason } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const { rows } = await tx.query<{ id: string; hint: string }>(
          `UPDATE platform.model_credentials
              SET removed_at = now(), removed_by = $1, removed_reason = $2, ciphertext = NULL
            WHERE removed_at IS NULL RETURNING id, hint`,
          [request.ctx.principal.subject, reason],
        );
        if (!rows[0]) throw notFound('Saved model key');
        await writeAudit(tx, request.ctx, {
          action: 'model_key.removed',
          resourceType: 'model_credential',
          resourceId: rows[0].id,
          reason,
          data: { endsWith: rows[0].hint },
        });
        return readConnection(tx);
      });
    },
  );

  app.post(
    '/v1/settings/model-connection/test',
    {
      config: {
        tenancy: 'platform',
        permission: 'settings:manage',
        // Each test calls the model service.
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['Settings'],
        summary: 'Test the connection to the model, with the saved key or one not yet saved',
        body: TestModelConnectionRequestSchema,
        response: { 200: ModelConnectionTestSchema, ...commonErrors },
      },
    },
    async (request) => {
      const entered = request.body.apiKey;
      const saved = entered ? null : await savedModelKey(deps.pool, deps.secrets);
      const apiKey = entered ?? saved?.apiKey;
      if (!apiKey) {
        throw new AppError(
          'conflict',
          'No key is saved. Enter a key to test it, or save one first.',
        );
      }
      const result = await testModelConnection({
        apiKey,
        source: entered ? 'entered' : 'saved',
        models: agentModels(),
        baseUrl: deps.modelServiceUrl,
      });
      const { principal } = request.ctx;
      await withTx(deps.pool, request.ctx, async (tx) => {
        // Only tests of the saved key are shown again; every test is audited.
        if (saved) {
          await tx.query(
            `INSERT INTO platform.model_connection_tests
               (credential_id, ok, outcome, message, models, latency_ms, tested_at, tested_by, tested_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              saved.id,
              result.ok,
              result.outcome,
              result.message,
              JSON.stringify(result.models),
              result.latencyMs,
              result.testedAt,
              principal.subject,
              principal.name,
            ],
          );
        }
        await writeAudit(tx, request.ctx, {
          action: 'model_key.tested',
          resourceType: 'model_credential',
          resourceId: saved?.id ?? 'not-saved',
          data: { source: result.source, outcome: result.outcome },
        });
      });
      return result;
    },
  );
};
