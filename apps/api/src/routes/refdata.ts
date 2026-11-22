import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  DecideRefdataRequestSchema,
  LoadRefdataRequestSchema,
  pageOf,
  PageQuerySchema,
  REFDATA_DATASET_CODES,
  REFDATA_DATASETS,
  RefdataDatasetSummarySchema,
  RefdataDiffSchema,
  RefdataEntrySchema,
  ReferenceDataApproved,
  RefdataVersionSchema,
  type RefdataDataset,
} from '@astra/contracts';
import {
  AppError,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  notFound,
  publishEvent,
  withIdempotency,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import {
  coerceRow,
  datasetFields,
  diffEntries,
  latestApproved,
  loadVersion,
  parseCsv,
  toVersion,
  versionInForce,
  type VersionRow,
} from '@astra/studio';
import type { AppDeps } from '../app';
import { commonErrors, idempotencyHeaders, idempotencyKey } from './shared';

/** Versioned reference data with effective dates and maker-checker approval (E16-F01-S02). */

const today = () => new Date().toISOString().slice(0, 10);
const datasetParam = z.object({
  dataset: z.enum(REFDATA_DATASET_CODES as [RefdataDataset, ...RefdataDataset[]]),
});
const versionParams = datasetParam.extend({ versionId: z.uuid() });

async function entriesOf(tx: Tx, versionId: string): Promise<Map<string, Record<string, unknown>>> {
  const { rows } = await tx.query<{ key: string; data: Record<string, unknown> }>(
    `SELECT key, data FROM refdata.entries WHERE version_id = $1`,
    [versionId],
  );
  return new Map(rows.map((r) => [r.key, r.data]));
}

async function findVersion(tx: Tx, dataset: string, id: string, lock = false): Promise<VersionRow> {
  const { rows } = await tx.query<VersionRow>(
    `SELECT * FROM refdata.versions WHERE id = $1 AND dataset = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [id, dataset],
  );
  if (!rows[0]) throw notFound('The reference data version');
  return rows[0];
}
export const refdataRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/reference-data',
    {
      config: { tenancy: 'platform', permission: 'refdata:read' },
      schema: {
        tags: ['Reference data'],
        summary: 'List reference datasets with the version in force today',
        response: {
          200: z.object({ items: z.array(RefdataDatasetSummarySchema) }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const pending = await tx.query<{ dataset: string; n: string }>(
          `SELECT dataset, count(*) AS n FROM refdata.versions WHERE status = 'draft' GROUP BY dataset`,
        );
        const pendingBy = new Map(pending.rows.map((r) => [r.dataset, Number(r.n)]));
        const items = [];
        for (const code of REFDATA_DATASET_CODES) {
          const def = REFDATA_DATASETS[code];
          const v = await versionInForce(tx, code, today());
          items.push({
            code,
            name: def.name,
            description: def.description,
            expectedSource: def.expectedSource,
            keyField: def.keyField,
            fields: datasetFields(code),
            inForce: v ? toVersion(v) : null,
            pending: pendingBy.get(code) ?? 0,
          });
        }
        return { items };
      }),
  );

  app.get(
    '/v1/reference-data/:dataset/versions',
    {
      config: { tenancy: 'platform', permission: 'refdata:read' },
      schema: {
        tags: ['Reference data'],
        summary: 'List the versions of a dataset, newest first',
        params: datasetParam,
        response: { 200: z.object({ items: z.array(RefdataVersionSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<VersionRow>(
          `SELECT * FROM refdata.versions WHERE dataset = $1 ORDER BY version DESC LIMIT 200`,
          [request.params.dataset],
        ),
      );
      return { items: rows.map(toVersion) };
    },
  );

  app.post(
    '/v1/reference-data/:dataset/versions',
    {
      config: { tenancy: 'platform', permission: 'refdata:manage' },
      bodyLimit: 32 * 1024 * 1024,
      schema: {
        tags: ['Reference data'],
        summary:
          'Load a new version of a dataset (a complete snapshot). It takes effect once someone else approves it.',
        params: datasetParam,
        headers: idempotencyHeaders,
        body: LoadRefdataRequestSchema,
        response: { 201: RefdataVersionSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const { dataset } = request.params;
      const body = request.body;
      const result = await withTx(deps.pool, request.ctx, (tx) =>
        withIdempotency(
          tx,
          request.ctx,
          {
            key: idempotencyKey(request),
            method: 'POST',
            path: `/v1/reference-data/${dataset}/versions`,
            body,
            accountId: null,
          },
          async () => {
            const row = await loadVersion(tx, request.ctx, dataset, body);
            return { status: 201, body: toVersion(row) };
          },
        ),
      );
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(201).send(result.body);
    },
  );

  app.addContentTypeParser(
    'text/csv',
    { parseAs: 'string', bodyLimit: 32 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/v1/reference-data/:dataset/versions/csv',
    {
      config: { tenancy: 'platform', permission: 'refdata:manage' },
      bodyLimit: 32 * 1024 * 1024,
      schema: {
        tags: ['Reference data'],
        summary:
          'Load a new version from a CSV file (first row: field names; lists separated by ";")',
        params: datasetParam,
        querystring: z.object({
          effectiveFrom: z.iso.date(),
          source: z.string().trim().min(3).max(500),
          notes: z.string().trim().max(1000).optional(),
        }),
        response: { 201: RefdataVersionSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const { dataset } = request.params;
      if (
        !(request.headers['content-type'] ?? '').startsWith('text/csv') ||
        typeof request.body !== 'string'
      ) {
        throw new AppError('validation_failed', 'Send the file as text/csv.');
      }
      let rows: Record<string, unknown>[];
      try {
        rows = parseCsv(request.body).map((r) => coerceRow(dataset, r));
      } catch (err) {
        throw new AppError(
          'validation_failed',
          `The CSV file could not be read: ${(err as Error).message}`,
        );
      }
      if (!rows.length) throw new AppError('validation_failed', 'The file has no entries.');
      const row = await withTx(deps.pool, request.ctx, (tx) =>
        loadVersion(tx, request.ctx, dataset, { ...request.query, entries: rows }),
      );
      return reply.code(201).send(toVersion(row));
    },
  );

  app.get(
    '/v1/reference-data/:dataset/versions/:versionId',
    {
      config: { tenancy: 'platform', permission: 'refdata:read' },
      schema: {
        tags: ['Reference data'],
        summary: 'Get a version and what it changes against the version before it',
        params: versionParams,
        response: {
          200: RefdataVersionSchema.extend({ diff: RefdataDiffSchema }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.dataset, request.params.versionId);
        // Compare with the approved version this one follows (or followed).
        const prev = (
          await tx.query<VersionRow>(
            `SELECT * FROM refdata.versions WHERE dataset = $1 AND status = 'approved' AND id <> $2
                AND effective_from < $3 ORDER BY effective_from DESC LIMIT 1`,
            [v.dataset, v.id, v.effective_from],
          )
        ).rows[0];
        const diff = diffEntries(
          prev ? await entriesOf(tx, prev.id) : new Map(),
          await entriesOf(tx, v.id),
        );
        return {
          ...toVersion(v),
          diff: { against: prev ? { id: prev.id, version: prev.version } : null, ...diff },
        };
      }),
  );

  app.get(
    '/v1/reference-data/:dataset/versions/:versionId/entries',
    {
      config: { tenancy: 'platform', permission: 'refdata:read' },
      schema: {
        tags: ['Reference data'],
        summary: 'List the entries of a version, by key',
        params: versionParams,
        querystring: PageQuerySchema.extend({ q: z.string().trim().min(1).max(100).optional() }),
        response: { 200: pageOf(RefdataEntrySchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, q } = request.query;
      const after = decodeCursor(cursor, 1);
      const rows = await withTx(deps.pool, request.ctx, async (tx) => {
        await findVersion(tx, request.params.dataset, request.params.versionId);
        return (
          await tx.query<{ key: string; data: Record<string, unknown> }>(
            `SELECT key, data FROM refdata.entries
              WHERE version_id = $1 AND ($2::text IS NULL OR key > $2)
                AND ($3::text IS NULL OR key ILIKE '%' || $3 || '%' OR data::text ILIKE '%' || $3 || '%')
              ORDER BY key LIMIT $4`,
            [request.params.versionId, after?.[0] ?? null, q ?? null, limit + 1],
          )
        ).rows;
      });
      const page = rows.slice(0, limit);
      return {
        items: page,
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.key]) : null,
      };
    },
  );

  app.post(
    '/v1/reference-data/:dataset/versions/:versionId/decision',
    {
      config: { tenancy: 'platform', permission: 'refdata:manage' },
      schema: {
        tags: ['Reference data'],
        summary: 'Approve or reject a version loaded by someone else (maker-checker)',
        params: versionParams,
        body: DecideRefdataRequestSchema,
        response: { 200: RefdataVersionSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const { dataset, versionId } = request.params;
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('refdata:' || $1))`, [dataset]);
        const v = await findVersion(tx, dataset, versionId, true);
        if (v.status !== 'draft') throw conflict(`Version ${v.version} is already ${v.status}.`);
        if (v.loaded_by === request.ctx.principal.subject) {
          throw forbidden(
            'A version must be approved or rejected by someone other than the person who loaded it.',
          );
        }
        const { decision, reason } = request.body;
        if (decision === 'approve') {
          const latest = await latestApproved(tx, dataset);
          if (latest && v.effective_from <= latest.effective_from) {
            throw conflict(
              `Version ${latest.version} is in force from ${latest.effective_from}; this version starts before it. Load it again with a later date.`,
            );
          }
          // The version it replaces ends the day this one starts.
          if (latest && (latest.effective_to === null || latest.effective_to > v.effective_from)) {
            await tx.query(`UPDATE refdata.versions SET effective_to = $2 WHERE id = $1`, [
              latest.id,
              v.effective_from,
            ]);
          }
        }
        const { rows } = await tx.query<VersionRow>(
          `UPDATE refdata.versions SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4
            WHERE id = $1 RETURNING *`,
          [
            v.id,
            decision === 'approve' ? 'approved' : 'rejected',
            request.ctx.principal.subject,
            reason,
          ],
        );
        const row = rows[0]!;
        if (decision === 'approve') {
          await publishEvent(
            tx,
            request.ctx,
            ReferenceDataApproved,
            {
              dataset,
              versionId: row.id,
              version: row.version,
              effectiveFrom: row.effective_from,
              entryCount: row.entry_count,
            },
            { accountId: null },
          );
        }
        await writeAudit(tx, request.ctx, {
          action: decision === 'approve' ? 'refdata.version_approved' : 'refdata.version_rejected',
          resourceType: 'refdata_version',
          resourceId: row.id,
          reason,
          data: {
            dataset,
            version: row.version,
            effectiveFrom: row.effective_from,
            loadedBy: row.loaded_by,
            sha256: row.sha256,
          },
        });
        return toVersion(row);
      }),
  );

  app.get(
    '/v1/reference-data/:dataset/entries',
    {
      config: { tenancy: 'platform', permission: 'refdata:read' },
      schema: {
        tags: ['Reference data'],
        summary: 'The entries in force on a date (default today)',
        params: datasetParam,
        querystring: z.object({
          asOf: z.iso.date().optional(),
          key: z.string().max(100).optional(),
        }),
        response: {
          200: z.object({ version: RefdataVersionSchema, items: z.array(RefdataEntrySchema) }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const date = request.query.asOf ?? today();
        const v = await versionInForce(tx, request.params.dataset, date);
        if (!v)
          throw new AppError(
            'not_found',
            `No version of ${request.params.dataset} is in force on ${date}.`,
          );
        const { rows } = await tx.query<{ key: string; data: Record<string, unknown> }>(
          `SELECT key, data FROM refdata.entries WHERE version_id = $1 AND ($2::text IS NULL OR key = $2) ORDER BY key`,
          [v.id, request.query.key ?? null],
        );
        return { version: toVersion(v), items: rows };
      }),
  );
};
