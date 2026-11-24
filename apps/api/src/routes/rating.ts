import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  CreateManualRequestSchema,
  CfarEligibilitySchema,
  ParityRunSchema,
  QuoteRatingRequestSchema,
  RateManualPublished,
  RateManualSchema,
  RatingRequestSchema,
  RatingResultSchema,
  type ManualDocument,
  type RateManual,
  type RatingRequest,
  type RatingResult,
} from '@astra/contracts';
import {
  AppError,
  canonicalJson,
  conflict,
  forbidden,
  notFound,
  preconditionFailed,
  publishEvent,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import {
  parseParityCsv,
  QuoteRatingError,
  rate,
  rateQuote,
  RatingError,
  runCase,
  type ManualForRating,
} from '@astra/rating';
import { approvalFor } from '@astra/studio';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';

/** Rate manual library, parity and rating (E02). Design: docs/adr/0006. */

interface ManualRow {
  id: string;
  code: string;
  state: string;
  benefit: string;
  version: number;
  status: RateManual['status'];
  effective_from: string;
  effective_to: string | null;
  illustrative: boolean;
  source: string;
  document: ManualDocument;
  sha256: string;
  created_by: string;
  created_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  published_by: string | null;
  published_at: Date | null;
}

const toManual = (r: ManualRow): RateManual => ({
  id: r.id,
  code: r.code,
  state: r.state,
  benefit: r.benefit,
  version: r.version,
  status: r.status,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  illustrative: r.illustrative,
  source: r.source,
  document: r.document,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  approvedBy: r.approved_by,
  publishedBy: r.published_by,
  publishedAt: r.published_at ? r.published_at.toISOString() : null,
});

const forRating = (r: ManualRow): ManualForRating => ({
  id: r.id,
  code: r.code,
  version: r.version,
  benefit: r.benefit,
  state: r.state,
  illustrative: r.illustrative,
  document: r.document,
});

const idParams = z.object({ manualId: z.uuid() });

async function findManual(tx: Tx, id: string, lock = false): Promise<ManualRow> {
  const { rows } = await tx.query<ManualRow>(
    `SELECT * FROM rating.manuals WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('The rate manual');
  return rows[0];
}

/** Tables referenced by the formula must exist. */
export function checkDocument(doc: ManualDocument): string[] {
  const ids = new Set(doc.tables.map((t) => t.id));
  const problems: string[] = [];
  const need = (id: string, what: string) => {
    if (!ids.has(id))
      problems.push(`${what} refers to table ${id}, which the manual does not contain.`);
  };
  need(doc.exposure.table, 'The trip cost factor');
  doc.variables.forEach((v) => v.tables.forEach((t) => need(t, v.label)));
  if (doc.perilPackage) need(doc.perilPackage.table, 'The peril package');
  if (doc.exclusionWaivers) need(doc.exclusionWaivers.table, 'Removal of exclusions');
  if (ids.size !== doc.tables.length) problems.push('Two tables have the same id.');
  return problems;
}

interface CaseRow {
  id: string;
  name: string;
  source: string;
  request: RatingRequest;
  expected_amount: string;
  expected_factors: Record<string, string>;
  source_row: number | null;
}

const casesHash = (cases: CaseRow[]) =>
  createHash('sha256')
    .update(
      canonicalJson(
        cases
          .map((c) => ({
            id: c.id,
            request: c.request,
            amount: c.expected_amount,
            factors: c.expected_factors,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      ),
    )
    .digest('hex');

async function casesFor(tx: Tx, code: string): Promise<CaseRow[]> {
  const { rows } = await tx.query<CaseRow>(
    `SELECT id, name, source, request, expected_amount, expected_factors, source_row FROM rating.parity_cases WHERE manual_code = $1 ORDER BY name`,
    [code],
  );
  return rows;
}

function rateOrFail(manual: ManualRow, request: RatingRequest): RatingResult {
  try {
    return rate(forRating(manual), request);
  } catch (err) {
    if (err instanceof RatingError) {
      throw new AppError(
        'validation_failed',
        err.message,
        err.field ? [{ code: 'rating', field: err.field, message: err.message }] : undefined,
      );
    }
    throw err;
  }
}

export const ratingRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.addContentTypeParser(
    'text/csv',
    { parseAs: 'string', bodyLimit: 8 * 1024 * 1024 },
    (_r, body, done) => done(null, body),
  );

  app.get(
    '/v1/rate-manuals',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'List rate manual versions',
        querystring: z.object({
          state: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
          benefit: z.string().max(8).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              RateManualSchema.omit({ document: true }).extend({ tables: z.number().int() }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<ManualRow>(
          `SELECT * FROM rating.manuals WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR benefit = $2)
            ORDER BY state, benefit, code, version DESC LIMIT 500`,
          [request.query.state ?? null, request.query.benefit ?? null],
        ),
      );
      return {
        items: rows.map((r) => ({
          ...toManual(r),
          document: undefined,
          tables: r.document.tables.length,
        })),
      };
    },
  );

  app.post(
    '/v1/rate-manuals',
    {
      config: { tenancy: 'platform', permission: 'rating:manage' },
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        tags: ['Rating'],
        summary: 'Load a rate manual version (draft) with its tables and formula',
        body: CreateManualRequestSchema,
        response: { 201: RateManualSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const b = request.body;
      if (b.illustrative && !deps.config.ALLOW_ILLUSTRATIVE_RATING) {
        throw forbidden(
          'Illustrative manuals (estimated loadings) are only allowed in demonstration and sandbox environments.',
        );
      }
      const problems = checkDocument(b.document);
      if (problems.length)
        throw new AppError(
          'validation_failed',
          problems[0]!,
          problems.map((m) => ({ code: 'manual', field: 'document', message: m })),
        );
      const row = await withTx(deps.pool, request.ctx, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('manual:' || $1))`, [b.code]);
        const existing = await tx.query<{ state: string; benefit: string }>(
          `SELECT state, benefit FROM rating.manuals WHERE code = $1 LIMIT 1`,
          [b.code],
        );
        if (
          existing.rows[0] &&
          (existing.rows[0].state !== b.state || existing.rows[0].benefit !== b.benefit)
        ) {
          throw conflict(
            `Manual ${b.code} is a ${existing.rows[0].state} ${existing.rows[0].benefit} manual.`,
          );
        }
        const next = await tx.query<{ n: number }>(
          `SELECT coalesce(max(version), 0) + 1 AS n FROM rating.manuals WHERE code = $1`,
          [b.code],
        );
        const sha256 = createHash('sha256').update(canonicalJson(b.document)).digest('hex');
        const r = (
          await tx.query<ManualRow>(
            `INSERT INTO rating.manuals (code, state, benefit, version, effective_from, illustrative, source, document, sha256, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [
              b.code,
              b.state,
              b.benefit,
              next.rows[0]!.n,
              b.effectiveFrom,
              b.illustrative,
              b.source,
              JSON.stringify(b.document),
              sha256,
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'rate_manual.loaded',
          resourceType: 'rate_manual',
          resourceId: r.id,
          data: {
            code: r.code,
            state: r.state,
            benefit: r.benefit,
            version: r.version,
            illustrative: r.illustrative,
            sha256,
          },
        });
        return r;
      });
      return reply.code(201).send(toManual(row));
    },
  );

  app.get(
    '/v1/rate-manuals/:manualId',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'Get a rate manual version',
        params: idParams,
        response: { 200: RateManualSchema, ...commonErrors },
      },
    },
    async (request) =>
      toManual(
        await withTx(deps.pool, request.ctx, (tx) => findManual(tx, request.params.manualId)),
      ),
  );

  app.post(
    '/v1/rate-manuals/:manualId/approve',
    {
      config: { tenancy: 'platform', permission: 'rating:approve' },
      schema: {
        tags: ['Rating'],
        summary:
          'Approve a draft manual loaded by someone else (nothing is published until a rating analyst approves it)',
        params: idParams,
        body: z.object({ note: z.string().trim().min(5).max(500) }),
        response: { 200: RateManualSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const m = await findManual(tx, request.params.manualId, true);
        if (m.status !== 'draft') throw conflict(`Version ${m.version} is already ${m.status}.`);
        if (m.created_by === request.ctx.principal.subject)
          throw forbidden(
            'A manual must be approved by someone other than the person who loaded it.',
          );
        const r = (
          await tx.query<ManualRow>(
            `UPDATE rating.manuals SET status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3 WHERE id = $1 RETURNING *`,
            [m.id, request.ctx.principal.subject, request.body.note],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'rate_manual.approved',
          resourceType: 'rate_manual',
          resourceId: m.id,
          reason: request.body.note,
          data: { code: m.code, version: m.version, sha256: m.sha256 },
        });
        return toManual(r);
      }),
  );

  app.get(
    '/v1/rate-manuals/:manualId/readiness',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'What stands between this manual and publication: approval, filing and parity',
        params: idParams,
        response: {
          200: z.object({
            ready: z.boolean(),
            checks: z.array(
              z.object({
                check: z.enum(['approved', 'filed', 'parity', 'not_illustrative']),
                passed: z.boolean(),
                detail: z.string(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) =>
        readiness(tx, await findManual(tx, request.params.manualId)),
      ),
  );

  async function readiness(tx: Tx, m: ManualRow) {
    const checks: {
      check: 'approved' | 'filed' | 'parity' | 'not_illustrative';
      passed: boolean;
      detail: string;
    }[] = [];
    checks.push({
      check: 'not_illustrative',
      passed: !m.illustrative,
      detail: m.illustrative
        ? 'Illustrative manuals (estimated loadings) can never be published.'
        : 'Filed values.',
    });
    checks.push({
      check: 'approved',
      passed: m.status === 'approved' || m.status === 'published',
      detail:
        m.status === 'draft'
          ? 'Waiting for approval by a second rating analyst.'
          : `Approved by ${m.approved_by}.`,
    });
    const filing = await approvalFor(
      tx,
      { itemType: 'rate_manual', itemReference: m.code },
      m.state,
      m.effective_from,
    );
    checks.push({ check: 'filed', passed: filing.approved, detail: filing.reason });
    const cases = await casesFor(tx, m.code);
    const run = (
      await tx.query<{ total: number; passed: number; cases_hash: string; ran_at: Date }>(
        `SELECT total, passed, cases_hash, ran_at FROM rating.parity_runs WHERE manual_id = $1 ORDER BY ran_at DESC LIMIT 1`,
        [m.id],
      )
    ).rows[0];
    let parity: { passed: boolean; detail: string };
    if (!cases.length)
      parity = {
        passed: false,
        detail: 'No parity cases from the filed manual or Assurant’s workbook yet.',
      };
    else if (!run)
      parity = {
        passed: false,
        detail: `${cases.length} cases have not been run against this version.`,
      };
    else if (run.cases_hash !== casesHash(cases))
      parity = {
        passed: false,
        detail: 'The parity cases changed since the last run; run them again.',
      };
    else
      parity = {
        passed: run.passed === run.total,
        detail: `${run.passed} of ${run.total} cases match to the cent.`,
      };
    checks.push({ check: 'parity', ...parity });
    return { ready: checks.every((c) => c.passed), checks };
  }

  app.post(
    '/v1/rate-manuals/:manualId/publish',
    {
      config: { tenancy: 'platform', permission: 'rating:approve' },
      schema: {
        tags: ['Rating'],
        summary:
          'Publish an approved manual: it needs an approved filing in effect and every parity case passing',
        params: idParams,
        response: { 200: RateManualSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const m = await findManual(tx, request.params.manualId, true);
        if (m.status !== 'approved')
          throw conflict(`Only an approved manual can be published; this one is ${m.status}.`);
        const r = await readiness(tx, m);
        const failed = r.checks.filter((c) => !c.passed);
        if (failed.length) {
          throw preconditionFailed(`Not published: ${failed.map((c) => c.detail).join(' ')}`);
        }
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('publish:' || $1 || ':' || $2))`, [
          m.state,
          m.benefit,
        ]);
        // The manual it replaces stops on the day this one starts.
        await tx.query(
          `UPDATE rating.manuals SET effective_to = $4
            WHERE state = $1 AND benefit = $2 AND status = 'published' AND id <> $3
              AND effective_from < $4 AND (effective_to IS NULL OR effective_to > $4)`,
          [m.state, m.benefit, m.id, m.effective_from],
        );
        let row: ManualRow;
        try {
          row = (
            await tx.query<ManualRow>(
              `UPDATE rating.manuals SET status = 'published', published_by = $2, published_at = now() WHERE id = $1 RETURNING *`,
              [m.id, request.ctx.principal.subject],
            )
          ).rows[0]!;
        } catch (err) {
          if ((err as { code?: string }).code === '23P01')
            throw conflict(
              `Another published ${m.state} ${m.benefit} manual already covers ${m.effective_from}.`,
            );
          throw err;
        }
        await publishEvent(
          tx,
          request.ctx,
          RateManualPublished,
          {
            manualId: row.id,
            code: row.code,
            state: row.state,
            benefit: row.benefit,
            version: row.version,
            effectiveFrom: row.effective_from,
          },
          { accountId: null },
        );
        await writeAudit(tx, request.ctx, {
          action: 'rate_manual.published',
          resourceType: 'rate_manual',
          resourceId: row.id,
          data: { code: row.code, version: row.version, checks: r.checks },
        });
        return toManual(row);
      }),
  );

  // ---------------- Parity ----------------

  app.get(
    '/v1/rate-manuals/:manualId/parity-cases',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'Parity cases for this filed manual',
        params: idParams,
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.uuid(),
                name: z.string(),
                source: z.string(),
                expectedAmount: z.string(),
                factors: z.number().int(),
                /** The row of the imported file (the header is row 1), when known. */
                sourceRow: z.number().int().nullable(),
                expectedFactors: z.record(z.string(), z.string()),
                request: z.unknown(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const m = await findManual(tx, request.params.manualId);
        return {
          items: (await casesFor(tx, m.code)).map((c) => ({
            id: c.id,
            name: c.name,
            source: c.source,
            expectedAmount: c.expected_amount,
            factors: Object.keys(c.expected_factors).length,
            sourceRow: c.source_row,
            expectedFactors: c.expected_factors,
            request: c.request,
          })),
        };
      }),
  );

  app.post(
    '/v1/rate-manuals/:manualId/parity-cases',
    {
      config: { tenancy: 'platform', permission: 'rating:manage' },
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        tags: ['Rating'],
        summary:
          'Import parity cases from a CSV export of the filed manual or an Assurant workbook (replaces cases with the same names)',
        params: idParams,
        querystring: z.object({
          source: z.string().trim().min(3).max(300),
          rateDate: z.iso.date(),
        }),
        response: { 201: z.object({ imported: z.number().int() }), ...commonErrors },
      },
    },
    async (request, reply) => {
      if (/prototype/i.test(request.query.source)) {
        throw new AppError(
          'validation_failed',
          'The prototype rater is never a parity source: use the filed manual or an Assurant workbook.',
          [{ code: 'parity_source', field: 'source', message: 'Not a parity source' }],
        );
      }
      if (typeof request.body !== 'string')
        throw new AppError('validation_failed', 'Send the cases as text/csv.');
      const imported = await withTx(deps.pool, request.ctx, async (tx) => {
        const m = await findManual(tx, request.params.manualId);
        const { cases, problems } = parseParityCsv(request.body as string, {
          state: m.state,
          benefit: m.benefit,
          rateDate: request.query.rateDate,
        });
        if (problems.length) {
          throw new AppError(
            'validation_failed',
            `${problems.length} problem${problems.length === 1 ? '' : 's'} in the file; nothing was imported.`,
            problems
              .slice(0, 100)
              .map((p) => ({ code: 'parity_case', field: `row ${p.row}`, message: p.message })),
          );
        }
        for (const c of cases) {
          await tx.query(
            `INSERT INTO rating.parity_cases (manual_code, name, source, request, expected_amount, expected_factors, created_by, source_row)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (manual_code, name) DO UPDATE SET source = EXCLUDED.source, request = EXCLUDED.request,
               expected_amount = EXCLUDED.expected_amount, expected_factors = EXCLUDED.expected_factors, source_row = EXCLUDED.source_row`,
            [
              m.code,
              c.name,
              request.query.source,
              JSON.stringify(c.request),
              c.expectedAmount,
              JSON.stringify(c.expectedFactors),
              request.ctx.principal.subject,
              c.sourceRow ?? null,
            ],
          );
        }
        await writeAudit(tx, request.ctx, {
          action: 'parity_cases.imported',
          resourceType: 'rate_manual',
          resourceId: m.id,
          data: { code: m.code, cases: cases.length, source: request.query.source },
        });
        return cases.length;
      });
      return reply.code(201).send({ imported });
    },
  );

  app.post(
    '/v1/rate-manuals/:manualId/parity-runs',
    {
      config: { tenancy: 'platform', permission: 'rating:manage' },
      schema: {
        tags: ['Rating'],
        summary: 'Run every parity case against this version and compare to the cent',
        params: idParams,
        response: { 201: ParityRunSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const run = await withTx(deps.pool, request.ctx, async (tx) => {
        const m = await findManual(tx, request.params.manualId);
        const cases = await casesFor(tx, m.code);
        if (!cases.length)
          throw preconditionFailed('There are no parity cases for this manual yet.');
        const results = cases.map((c) => ({
          caseId: c.id,
          ...runCase(forRating(m), {
            name: c.name,
            request: c.request,
            expectedAmount: c.expected_amount,
            expectedFactors: c.expected_factors,
          }),
        }));
        const passed = results.filter((r) => r.passed).length;
        const ranAt = (
          await tx.query<{ ran_at: Date }>(
            `INSERT INTO rating.parity_runs (manual_id, ran_by, total, passed, cases_hash, results) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ran_at`,
            [
              m.id,
              request.ctx.principal.subject,
              results.length,
              passed,
              casesHash(cases),
              JSON.stringify(results),
            ],
          )
        ).rows[0]!.ran_at;
        await writeAudit(tx, request.ctx, {
          action: 'parity.run',
          resourceType: 'rate_manual',
          resourceId: m.id,
          data: { code: m.code, version: m.version, total: results.length, passed },
        });
        return {
          manualId: m.id,
          ranAt: ranAt.toISOString(),
          total: results.length,
          passed,
          results,
        };
      });
      return reply.code(201).send(run);
    },
  );

  app.get(
    '/v1/rate-manuals/:manualId/parity-runs/latest',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'The latest parity run for this version',
        params: idParams,
        response: { 200: ParityRunSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{
            manual_id: string;
            ran_at: Date;
            total: number;
            passed: number;
            results: ParityRunResults;
          }>(
            `SELECT manual_id, ran_at, total, passed, results FROM rating.parity_runs WHERE manual_id = $1 ORDER BY ran_at DESC LIMIT 1`,
            [request.params.manualId],
          )
        ).rows[0];
        if (!r) throw notFound('A parity run');
        return {
          manualId: r.manual_id,
          ranAt: r.ran_at.toISOString(),
          total: r.total,
          passed: r.passed,
          results: r.results,
        };
      }),
  );

  // ---------------- Rating ----------------

  app.post(
    '/v1/rating/rate',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'Rate one traveller for one benefit and return the worksheet',
        description:
          'Without manualId, the published manual for the state and benefit in effect on the rate date is used. With manualId, that version is used as a preview (any status), labelled as such. Pass store=true to keep the worksheet for later reproduction.',
        body: z.object({
          manualId: z.uuid().optional(),
          request: RatingRequestSchema,
          store: z.boolean().default(false),
          /** Required for CFAR manuals: CFAR is rated only when its eligibility rules pass. */
          cfarEligibility: CfarEligibilitySchema.optional(),
        }),
        response: {
          200: RatingResultSchema.extend({
            preview: z.boolean(),
            worksheetId: z.uuid().nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const { manualId, request: req, store, cfarEligibility } = request.body;
        let m: ManualRow;
        if (manualId) {
          m = await findManual(tx, manualId);
          if (m.state !== req.state || m.benefit !== req.benefit)
            throw new AppError('validation_failed', `This is a ${m.state} ${m.benefit} manual.`);
          if (m.illustrative && !deps.config.ALLOW_ILLUSTRATIVE_RATING)
            throw forbidden(
              'Illustrative manuals are only rated in demonstration and sandbox environments.',
            );
        } else {
          const found = (
            await tx.query<ManualRow>(
              `SELECT * FROM rating.manuals WHERE state = $1 AND benefit = $2 AND status = 'published'
                  AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to > $3::date)`,
              [req.state, req.benefit, req.rateDate],
            )
          ).rows[0];
          if (!found) {
            throw new AppError(
              'precondition_failed',
              `No published ${req.benefit} manual is in effect in ${req.state} on ${req.rateDate}, so this benefit cannot be rated there.`,
            );
          }
          m = found;
        }
        if (m.document.exposure.kind === 'per_100_cfar_insured_cost') {
          if (!cfarEligibility) {
            throw new AppError(
              'validation_failed',
              'CFAR is rated only with a CFAR eligibility decision.',
              [
                {
                  code: 'cfar_eligibility',
                  field: 'cfarEligibility',
                  message: 'Give the eligibility decision',
                },
              ],
            );
          }
          if (!cfarEligibility.passed) {
            throw new AppError(
              'precondition_failed',
              `CFAR is not rated: ${cfarEligibility.reasons.join(' ') || 'its eligibility rules did not pass.'}`,
            );
          }
        }
        const result = rateOrFail(m, req);
        let worksheetId: string | null = null;
        if (store) {
          worksheetId = (
            await tx.query<{ id: string }>(
              `INSERT INTO rating.worksheets (manual_id, inputs_hash, request, result, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [
                m.id,
                result.inputsHash,
                JSON.stringify(req),
                JSON.stringify(result),
                request.ctx.principal.subject,
              ],
            )
          ).rows[0]!.id;
        }
        return { ...result, preview: !!manualId && m.status !== 'published', worksheetId };
      }),
  );

  app.post(
    '/v1/rating/quote',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'Rate every selected benefit for every traveller in one request (E02-F05-S01)',
        description:
          'Each benefit uses the published manual for the state in effect on the rate date (or a labelled preview version from previewManuals). Totals per traveller, per benefit and per policy, and the amount on the billing basis when one is given. CFAR is rated only with a passed eligibility decision.',
        body: QuoteRatingRequestSchema,
        response: {
          200: z.object({
            kind: z.enum(['premium', 'loss_cost', 'mixed']),
            illustrative: z.boolean(),
            preview: z.boolean(),
            lines: z.array(
              z.object({
                benefit: z.string(),
                travellerId: z.string(),
                result: RatingResultSchema,
              }),
            ),
            notRated: z.array(z.object({ benefit: z.string(), reasons: z.array(z.string()) })),
            perTraveller: z.array(z.object({ travellerId: z.string(), total: z.string() })),
            perBenefit: z.array(z.object({ benefit: z.string(), total: z.string() })),
            policyTotal: z.string(),
            basis: z
              .object({
                basis: z.string(),
                amount: z.string(),
                unit: z.string(),
                method: z.string(),
                approved: z.boolean(),
                fixedFeePerPolicy: z.string().nullable(),
              })
              .nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const q = request.body;
        const manuals = new Map<string, ManualRow>();
        let preview = false;
        for (const b of q.benefits) {
          if (manuals.has(b.benefit)) continue;
          const previewId = q.previewManuals?.[b.benefit];
          let row: ManualRow | undefined;
          if (previewId) {
            row = await findManual(tx, previewId);
            if (row.benefit !== b.benefit || row.state !== q.state)
              throw new AppError(
                'validation_failed',
                `Preview manual for ${b.benefit} is a ${row.state} ${row.benefit} manual.`,
              );
            if (row.illustrative && !deps.config.ALLOW_ILLUSTRATIVE_RATING)
              throw forbidden(
                'Illustrative manuals are only rated in demonstration and sandbox environments.',
              );
            preview ||= row.status !== 'published';
          } else {
            row = (
              await tx.query<ManualRow>(
                `SELECT * FROM rating.manuals WHERE state = $1 AND benefit = $2 AND status = 'published'
                    AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to > $3::date)`,
                [q.state, b.benefit, q.rateDate],
              )
            ).rows[0];
          }
          if (row) manuals.set(b.benefit, row);
        }
        try {
          const result = rateQuote(q, (benefit) => {
            const m = manuals.get(benefit);
            if (!m)
              throw new RatingError(
                `No published ${benefit} manual is in effect in ${q.state} on ${q.rateDate}, so ${benefit} cannot be rated there.`,
              );
            return forRating(m);
          });
          return { ...result, preview };
        } catch (err) {
          if (err instanceof QuoteRatingError) {
            throw new AppError(
              'validation_failed',
              err.problems.length === 1
                ? err.problems[0]!.message
                : `${err.problems.length} problems: the quote could not be rated.`,
              err.problems
                .slice(0, 100)
                .map((p) => ({ code: 'rating', field: p.field ?? p.benefit, message: p.message })),
            );
          }
          if (err instanceof RatingError) throw new AppError('validation_failed', err.message);
          throw err;
        }
      }),
  );

  app.get(
    '/v1/rating/worksheets/:worksheetId',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'A stored worksheet',
        params: z.object({ worksheetId: z.uuid() }),
        response: {
          200: RatingResultSchema.extend({ request: RatingRequestSchema }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const w = (
          await tx.query<{ request: RatingRequest; result: RatingResult }>(
            `SELECT request, result FROM rating.worksheets WHERE id = $1`,
            [request.params.worksheetId],
          )
        ).rows[0];
        if (!w) throw notFound('The worksheet');
        return { ...w.result, request: w.request };
      }),
  );

  app.post(
    '/v1/rating/worksheets/:worksheetId/reproduce',
    {
      config: { tenancy: 'platform', permission: 'rating:read' },
      schema: {
        tags: ['Rating'],
        summary: 'Re-rate a stored worksheet with the same manual version and compare it exactly',
        params: z.object({ worksheetId: z.uuid() }),
        response: {
          200: z.object({
            identical: z.boolean(),
            stored: RatingResultSchema,
            reproduced: RatingResultSchema,
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const w = (
          await tx.query<{ manual_id: string; request: RatingRequest; result: RatingResult }>(
            `SELECT manual_id, request, result FROM rating.worksheets WHERE id = $1`,
            [request.params.worksheetId],
          )
        ).rows[0];
        if (!w) throw notFound('The worksheet');
        const reproduced = rateOrFail(await findManual(tx, w.manual_id), w.request);
        return {
          identical: canonicalJson(reproduced) === canonicalJson(w.result),
          stored: w.result,
          reproduced,
        };
      }),
  );
};

type ParityRunResults = z.infer<typeof ParityRunSchema>['results'];
