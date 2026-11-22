import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  ApproveMapRequestSchema,
  BracketSpanSchema,
  CreateFormEditionQuerySchema,
  FORM_KINDS,
  FormEditionLoaded,
  FormEditionSchema,
  FormTextSchema,
  FormVariableInputSchema,
  REFDATA_DATASET_CODES,
  UsabilityAnswerSchema,
  VariableMapApproved,
  VariableMapSchema,
  type FormEdition,
  type FormVariable,
  type VariableMap,
} from '@astra/contracts';
import {
  AppError,
  conflict,
  FileTooLargeError,
  forbidden,
  isUniqueViolation,
  notFound,
  publishEvent,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import {
  approvalFor,
  checkLocation,
  extractText,
  filingsFor,
  findBrackets,
  pageOf,
  UnreadableDocumentError,
} from '@astra/studio';
import type { AppDeps } from '../app';
import { toFiling } from './filings';
import { commonErrors } from './shared';

/** Form and schedule library with variable maps (E01-F01-S01, E01-F01-S02). */

const MAX_FORM_BYTES = 25 * 1024 * 1024;
const CONTENT_TYPES = ['application/pdf', 'text/plain'] as const;

interface EditionRow {
  id: string;
  form_number: string;
  edition: string;
  title: string;
  kind: FormEdition['kind'];
  insurer: FormEdition['insurer'];
  file_name: string;
  content_type: string;
  storage_key: string;
  sha256: string;
  size_bytes: string;
  page_starts: number[];
  text_length: number;
  created_by: string;
  created_at: Date;
}

interface MapRow {
  id: string;
  edition_id: string;
  version: number;
  status: VariableMap['status'];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  approval_note: string | null;
  contributors: string[];
}

interface VariableRow {
  key: string;
  label: string;
  type: FormVariable['type'];
  constraints: Record<string, unknown>;
  text_start: number;
  text_end: number;
  excerpt: string;
  notes: string | null;
}

const EDITION_COLUMNS = `id, form_number, edition, title, kind, insurer, file_name, content_type, storage_key, sha256,
  size_bytes, page_starts, char_length(text) AS text_length, created_by, created_at`;

const editionParams = z.object({ editionId: z.uuid() });
const mapParams = z.object({ mapId: z.uuid() });
const today = () => new Date().toISOString().slice(0, 10);

async function findEdition(tx: Tx, id: string): Promise<EditionRow> {
  const { rows } = await tx.query<EditionRow>(
    `SELECT ${EDITION_COLUMNS} FROM studio.form_editions WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('The form edition');
  return rows[0];
}

async function editionText(tx: Tx, id: string): Promise<{ text: string; page_starts: number[] }> {
  const { rows } = await tx.query<{ text: string; page_starts: number[] }>(
    `SELECT text, page_starts FROM studio.form_editions WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('The form edition');
  return rows[0];
}

async function mapSummaries(tx: Tx, editionId: string) {
  const { rows } = await tx.query<{ id: string; version: number; status: string; n: string }>(
    `SELECT m.id, m.version, m.status, (SELECT count(*) FROM studio.form_variables v WHERE v.map_id = m.id) AS n
       FROM studio.variable_maps m WHERE m.edition_id = $1 AND m.status IN ('draft', 'approved')`,
    [editionId],
  );
  const pick = (status: string) => {
    const r = rows.find((x) => x.status === status);
    return r ? { id: r.id, version: r.version, variables: Number(r.n) } : null;
  };
  return { currentMap: pick('approved'), draftMap: pick('draft') };
}

async function toEdition(tx: Tx, r: EditionRow): Promise<FormEdition> {
  const filings = await filingsFor(tx, { itemType: 'form_edition', itemId: r.id });
  return {
    id: r.id,
    formNumber: r.form_number,
    edition: r.edition,
    title: r.title,
    kind: r.kind,
    insurer: r.insurer,
    fileName: r.file_name,
    contentType: r.content_type,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    pageCount: r.page_starts.length,
    textLength: r.text_length,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    filings: filings.map(toFiling),
    ...(await mapSummaries(tx, r.id)),
  };
}

async function findMap(tx: Tx, id: string, lock = false): Promise<MapRow> {
  const { rows } = await tx.query<MapRow>(
    `SELECT * FROM studio.variable_maps WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('The variable map');
  return rows[0];
}

async function toMap(tx: Tx, m: MapRow): Promise<VariableMap> {
  const { page_starts } = await editionText(tx, m.edition_id);
  const vars = await tx.query<VariableRow>(
    `SELECT key, label, type, constraints, text_start, text_end, excerpt, notes FROM studio.form_variables
      WHERE map_id = $1 ORDER BY text_start, position`,
    [m.id],
  );
  return {
    id: m.id,
    editionId: m.edition_id,
    version: m.version,
    status: m.status,
    createdBy: m.created_by,
    createdAt: m.created_at.toISOString(),
    updatedAt: m.updated_at.toISOString(),
    approvedBy: m.approved_by,
    approvedAt: m.approved_at ? m.approved_at.toISOString() : null,
    approvalNote: m.approval_note,
    contributors: m.contributors,
    variables: vars.rows.map((v) => ({
      key: v.key,
      label: v.label,
      type: v.type,
      constraints: v.constraints,
      textStart: v.text_start,
      textEnd: v.text_end,
      page: pageOf(page_starts, v.text_start),
      excerpt: v.excerpt,
      notes: v.notes,
    })),
  };
}

/** A draft map may only be changed while it is a draft; every editor is recorded for maker-checker. */
async function editableDraft(tx: Tx, mapId: string, subject: string): Promise<MapRow> {
  const m = await findMap(tx, mapId, true);
  if (m.status !== 'draft')
    throw conflict(
      `Version ${m.version} of this map is ${m.status} and cannot change. Start a new draft.`,
    );
  await tx.query(
    `UPDATE studio.variable_maps SET updated_at = now(),
            contributors = CASE WHEN $2 = ANY (contributors) THEN contributors ELSE contributors || $2 END
      WHERE id = $1`,
    [m.id, subject],
  );
  return m;
}

export const formRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // Documents stream to storage unparsed (scoped to this plugin's routes; text/plain replaces the default).
  app.removeContentTypeParser('text/plain');
  for (const type of CONTENT_TYPES) {
    app.addContentTypeParser(type, (_request, payload, done) => done(null, payload));
  }

  app.get(
    '/v1/form-editions',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Forms'],
        summary: 'List filed forms and schedules, newest edition first',
        querystring: z.object({
          kind: z.enum(FORM_KINDS).optional(),
          q: z.string().trim().min(1).max(100).optional(),
        }),
        response: { 200: z.object({ items: z.array(FormEditionSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const { rows } = await tx.query<EditionRow>(
          `SELECT ${EDITION_COLUMNS} FROM studio.form_editions
            WHERE ($1::text IS NULL OR kind = $1)
              AND ($2::text IS NULL OR form_number ILIKE '%' || $2 || '%' OR title ILIKE '%' || $2 || '%')
            ORDER BY form_number, edition DESC LIMIT 500`,
          [request.query.kind ?? null, request.query.q ?? null],
        );
        const items = [];
        for (const r of rows) items.push(await toEdition(tx, r));
        return { items };
      }),
  );

  app.post(
    '/v1/form-editions',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      bodyLimit: MAX_FORM_BYTES,
      schema: {
        tags: ['Forms'],
        summary: 'Load a filed form or schedule edition (PDF with a text layer, or plain text)',
        description:
          'Send the document as the request body with content type application/pdf or text/plain.',
        querystring: CreateFormEditionQuerySchema,
        response: { 201: FormEditionSchema, ...commonErrors, 413: z.any() },
      },
    },
    async (request, reply) => {
      const q = request.query;
      const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!(CONTENT_TYPES as readonly string[]).includes(contentType)) {
        throw new AppError('validation_failed', 'Send the form as application/pdf or text/plain.');
      }
      const key = `forms/${randomUUID()}`;
      let stored;
      try {
        stored = await deps.files.put(key, request.body as Readable, MAX_FORM_BYTES);
      } catch (err) {
        if (err instanceof FileTooLargeError)
          throw new AppError('payload_too_large', 'Form documents are limited to 25 MB.');
        throw err;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of deps.files.read(key)) chunks.push(chunk as Buffer);
      let extracted;
      try {
        extracted = await extractText(new Uint8Array(Buffer.concat(chunks)), contentType);
      } catch (err) {
        await deps.files.remove(key);
        if (err instanceof UnreadableDocumentError || err instanceof TypeError) {
          throw new AppError(
            'validation_failed',
            err instanceof UnreadableDocumentError
              ? err.message
              : 'The text file is not valid UTF-8.',
          );
        }
        throw err;
      }
      try {
        const edition = await withTx(deps.pool, request.ctx, async (tx) => {
          const row = (
            await tx.query<EditionRow>(
              `INSERT INTO studio.form_editions (form_number, edition, title, kind, insurer, file_name, content_type,
                                                 storage_key, sha256, size_bytes, text, page_starts, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${EDITION_COLUMNS}`,
              [
                q.formNumber,
                q.edition,
                q.title,
                q.kind,
                q.insurer,
                q.fileName,
                contentType,
                key,
                stored.sha256,
                stored.sizeBytes,
                extracted.text,
                extracted.pageStarts,
                request.ctx.principal.subject,
              ],
            )
          ).rows[0]!;
          await publishEvent(
            tx,
            request.ctx,
            FormEditionLoaded,
            {
              editionId: row.id,
              formNumber: row.form_number,
              edition: row.edition,
              sha256: row.sha256,
            },
            { accountId: null },
          );
          await writeAudit(tx, request.ctx, {
            action: 'form_edition.loaded',
            resourceType: 'form_edition',
            resourceId: row.id,
            data: {
              formNumber: row.form_number,
              edition: row.edition,
              kind: row.kind,
              insurer: row.insurer,
              sha256: row.sha256,
              pages: extracted.pageStarts.length,
            },
          });
          return toEdition(tx, row);
        });
        return reply.code(201).header('location', `/v1/form-editions/${edition.id}`).send(edition);
      } catch (err) {
        await deps.files.remove(key);
        if (isUniqueViolation(err)) {
          throw conflict(
            (err as { constraint?: string }).constraint === 'form_editions_sha256_key'
              ? 'This document is already in the library.'
              : `Edition ${q.edition} of ${q.formNumber} is already in the library. Editions are never replaced; load a new edition.`,
          );
        }
        throw err;
      }
    },
  );

  app.get(
    '/v1/form-editions/:editionId',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Forms'],
        summary: 'Get a form edition with its filings by state and its variable maps',
        params: editionParams,
        response: { 200: FormEditionSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) =>
        toEdition(tx, await findEdition(tx, request.params.editionId)),
      ),
  );

  app.get(
    '/v1/form-editions/:editionId/text',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Forms'],
        summary: 'The extracted text of a form edition, with page boundaries',
        params: editionParams,
        response: { 200: FormTextSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const t = await editionText(tx, request.params.editionId);
        return { text: t.text, pageStarts: t.page_starts };
      }),
  );

  app.get(
    '/v1/form-editions/:editionId/document',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Forms'],
        summary: 'Download the filed document as loaded',
        params: editionParams,
      },
    },
    async (request, reply) => {
      const ed = await withTx(deps.pool, request.ctx, (tx) =>
        findEdition(tx, request.params.editionId),
      );
      return reply
        .header('content-type', ed.content_type)
        .header(
          'content-disposition',
          `attachment; filename="${ed.file_name.replace(/[^A-Za-z0-9 ._()-]/g, '_')}"`,
        )
        .header('x-content-sha256', ed.sha256)
        .send(deps.files.read(ed.storage_key));
    },
  );

  app.get(
    '/v1/form-editions/:editionId/brackets',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Forms'],
        summary: 'Bracketed wording and placeholders in the form, with suggested variable types',
        description:
          'Suggestions are deterministic readings of the wording; a person accepts or corrects each one.',
        params: editionParams,
        response: { 200: z.object({ items: z.array(BracketSpanSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const t = await editionText(tx, request.params.editionId);
        const mapped = await tx.query<{ text_start: number; text_end: number }>(
          `SELECT v.text_start, v.text_end FROM studio.form_variables v JOIN studio.variable_maps m ON m.id = v.map_id
            WHERE m.edition_id = $1 AND m.status IN ('draft', 'approved')`,
          [request.params.editionId],
        );
        const isMapped = (s: number, e: number) =>
          mapped.rows.some((v) => v.text_start === s && v.text_end === e);
        return {
          items: findBrackets(t.text, t.page_starts).map((b) => ({
            ...b,
            mapped: isMapped(b.start, b.end),
          })),
        };
      }),
  );

  app.get(
    '/v1/form-editions/:editionId/usability',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Forms'],
        summary:
          'Can this edition be used in a plan in a state on a date? (approved filing in effect)',
        params: editionParams,
        querystring: z.object({
          state: z.string().regex(/^[A-Z]{2}$/),
          date: z.iso.date().optional(),
        }),
        response: { 200: UsabilityAnswerSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await findEdition(tx, request.params.editionId);
        const a = await approvalFor(
          tx,
          { itemType: 'form_edition', itemId: request.params.editionId },
          request.query.state,
          request.query.date ?? today(),
        );
        return {
          usable: a.approved,
          reason: a.reason,
          filing: a.filing ? toFiling(a.filing) : null,
        };
      }),
  );

  // ---------------- Variable maps ----------------

  app.get(
    '/v1/form-editions/:editionId/maps',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Forms'],
        summary: 'Variable map versions of an edition, newest first',
        params: editionParams,
        response: {
          200: z.object({
            items: z.array(
              VariableMapSchema.omit({ variables: true }).extend({
                variableCount: z.number().int(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await findEdition(tx, request.params.editionId);
        const { rows } = await tx.query<MapRow & { n: string }>(
          `SELECT m.*, (SELECT count(*) FROM studio.form_variables v WHERE v.map_id = m.id) AS n
             FROM studio.variable_maps m WHERE m.edition_id = $1 ORDER BY m.version DESC`,
          [request.params.editionId],
        );
        return {
          items: rows.map((m) => ({
            id: m.id,
            editionId: m.edition_id,
            version: m.version,
            status: m.status,
            createdBy: m.created_by,
            createdAt: m.created_at.toISOString(),
            updatedAt: m.updated_at.toISOString(),
            approvedBy: m.approved_by,
            approvedAt: m.approved_at ? m.approved_at.toISOString() : null,
            approvalNote: m.approval_note,
            contributors: m.contributors,
            variableCount: Number(m.n),
          })),
        };
      }),
  );

  app.post(
    '/v1/form-editions/:editionId/maps',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      schema: {
        tags: ['Forms'],
        summary: 'Start a draft variable map (a copy of the approved map, if there is one)',
        params: editionParams,
        response: { 201: VariableMapSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const map = await withTx(deps.pool, request.ctx, async (tx) => {
        await findEdition(tx, request.params.editionId);
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('variable-map:' || $1))`, [
          request.params.editionId,
        ]);
        const existing = await tx.query(
          `SELECT 1 FROM studio.variable_maps WHERE edition_id = $1 AND status = 'draft'`,
          [request.params.editionId],
        );
        if (existing.rowCount)
          throw conflict('This edition already has a draft map. Continue that one.');
        const next = await tx.query<{ n: number }>(
          `SELECT coalesce(max(version), 0) + 1 AS n FROM studio.variable_maps WHERE edition_id = $1`,
          [request.params.editionId],
        );
        const m = (
          await tx.query<MapRow>(
            `INSERT INTO studio.variable_maps (edition_id, version, created_by, contributors) VALUES ($1, $2, $3, ARRAY[$3]) RETURNING *`,
            [request.params.editionId, next.rows[0]!.n, request.ctx.principal.subject],
          )
        ).rows[0]!;
        await tx.query(
          `INSERT INTO studio.form_variables (map_id, key, label, type, constraints, text_start, text_end, excerpt, position, notes)
           SELECT $1, v.key, v.label, v.type, v.constraints, v.text_start, v.text_end, v.excerpt, v.position, v.notes
             FROM studio.form_variables v JOIN studio.variable_maps a ON a.id = v.map_id
            WHERE a.edition_id = $2 AND a.status = 'approved'`,
          [m.id, request.params.editionId],
        );
        await writeAudit(tx, request.ctx, {
          action: 'variable_map.draft_started',
          resourceType: 'variable_map',
          resourceId: m.id,
          data: { editionId: m.edition_id, version: m.version },
        });
        return toMap(tx, m);
      });
      return reply.code(201).send(map);
    },
  );

  app.get(
    '/v1/variable-maps/:mapId',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Forms'],
        summary: 'Get a variable map with its variables',
        params: mapParams,
        response: { 200: VariableMapSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) =>
        toMap(tx, await findMap(tx, request.params.mapId)),
      ),
  );

  app.put(
    '/v1/variable-maps/:mapId/variables/:key',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      schema: {
        tags: ['Forms'],
        summary: 'Add or replace a variable in a draft map',
        params: mapParams.extend({ key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }),
        body: FormVariableInputSchema,
        response: { 200: VariableMapSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const v = request.body;
        if (v.key !== request.params.key) {
          throw new AppError('validation_failed', 'The key in the body must match the address.', [
            { code: 'key_mismatch', field: 'key', message: 'Must match the URL' },
          ]);
        }
        if (
          v.type === 'insert_placeholder' &&
          v.constraints.source === 'dataset' &&
          !(REFDATA_DATASET_CODES as string[]).includes(v.constraints.dataset!)
        ) {
          throw new AppError('validation_failed', 'Unknown reference dataset.', [
            {
              code: 'unknown_dataset',
              field: 'constraints.dataset',
              message: 'Choose a reference dataset',
            },
          ]);
        }
        const m = await editableDraft(tx, request.params.mapId, request.ctx.principal.subject);
        const t = await editionText(tx, m.edition_id);
        const problem = checkLocation(t.text, v.textStart, v.textEnd, v.excerpt);
        if (problem) {
          throw new AppError('validation_failed', problem, [
            { code: 'location', field: 'excerpt', message: problem },
          ]);
        }
        const clash = await tx.query<{ key: string }>(
          `SELECT key FROM studio.form_variables WHERE map_id = $1 AND key <> $2 AND text_start = $3 AND text_end = $4`,
          [m.id, v.key, v.textStart, v.textEnd],
        );
        if (clash.rows[0])
          throw conflict(`That wording is already mapped as ${clash.rows[0].key}.`);
        const pos = await tx.query<{ n: number }>(
          `SELECT coalesce(max(position), 0) + 1 AS n FROM studio.form_variables WHERE map_id = $1`,
          [m.id],
        );
        await tx.query(
          `INSERT INTO studio.form_variables (map_id, key, label, type, constraints, text_start, text_end, excerpt, position, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (map_id, key) DO UPDATE SET label = EXCLUDED.label, type = EXCLUDED.type,
             constraints = EXCLUDED.constraints, text_start = EXCLUDED.text_start, text_end = EXCLUDED.text_end,
             excerpt = EXCLUDED.excerpt, notes = EXCLUDED.notes`,
          [
            m.id,
            v.key,
            v.label,
            v.type,
            JSON.stringify(v.constraints),
            v.textStart,
            v.textEnd,
            v.excerpt,
            pos.rows[0]!.n,
            v.notes ?? null,
          ],
        );
        return toMap(tx, await findMap(tx, m.id));
      }),
  );

  app.delete(
    '/v1/variable-maps/:mapId/variables/:key',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      schema: {
        tags: ['Forms'],
        summary: 'Remove a variable from a draft map',
        params: mapParams.extend({ key: z.string().max(64) }),
        response: { 200: VariableMapSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const m = await editableDraft(tx, request.params.mapId, request.ctx.principal.subject);
        const del = await tx.query(
          `DELETE FROM studio.form_variables WHERE map_id = $1 AND key = $2`,
          [m.id, request.params.key],
        );
        if (!del.rowCount) throw notFound('The variable');
        return toMap(tx, await findMap(tx, m.id));
      }),
  );

  app.delete(
    '/v1/variable-maps/:mapId',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      schema: {
        tags: ['Forms'],
        summary: 'Discard a draft map',
        params: mapParams,
        response: { 204: z.null(), ...commonErrors },
      },
    },
    async (request, reply) => {
      await withTx(deps.pool, request.ctx, async (tx) => {
        const m = await findMap(tx, request.params.mapId, true);
        if (m.status !== 'draft') throw conflict('Only a draft map can be discarded.');
        await tx.query(`DELETE FROM studio.variable_maps WHERE id = $1`, [m.id]);
        await writeAudit(tx, request.ctx, {
          action: 'variable_map.discarded',
          resourceType: 'variable_map',
          resourceId: m.id,
          data: { version: m.version },
        });
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/variable-maps/:mapId/approve',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      schema: {
        tags: ['Forms'],
        summary:
          'Approve a draft map (by someone who did not build it); it replaces the current map',
        params: mapParams,
        body: ApproveMapRequestSchema,
        response: { 200: VariableMapSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const m = await findMap(tx, request.params.mapId, true);
        if (m.status !== 'draft') throw conflict(`Version ${m.version} is already ${m.status}.`);
        if (m.contributors.includes(request.ctx.principal.subject)) {
          throw forbidden(
            'A variable map must be approved by someone who did not create or edit it.',
          );
        }
        const n = Number(
          (
            await tx.query<{ n: string }>(
              `SELECT count(*) AS n FROM studio.form_variables WHERE map_id = $1`,
              [m.id],
            )
          ).rows[0]!.n,
        );
        if (n === 0) throw new AppError('precondition_failed', 'The map has no variables yet.');
        await tx.query(
          `UPDATE studio.variable_maps SET status = 'superseded' WHERE edition_id = $1 AND status = 'approved'`,
          [m.edition_id],
        );
        const row = (
          await tx.query<MapRow>(
            `UPDATE studio.variable_maps SET status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3
              WHERE id = $1 RETURNING *`,
            [m.id, request.ctx.principal.subject, request.body.note],
          )
        ).rows[0]!;
        await publishEvent(
          tx,
          request.ctx,
          VariableMapApproved,
          { editionId: row.edition_id, mapId: row.id, version: row.version, variables: n },
          { accountId: null },
        );
        await writeAudit(tx, request.ctx, {
          action: 'variable_map.approved',
          resourceType: 'variable_map',
          resourceId: row.id,
          reason: request.body.note,
          data: {
            editionId: row.edition_id,
            version: row.version,
            variables: n,
            contributors: row.contributors,
          },
        });
        return toMap(tx, row);
      }),
  );
};
