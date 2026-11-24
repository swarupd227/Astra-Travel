import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  BenefitCatalogueApproved,
  BenefitCatalogueSchema,
  BenefitSchema,
  CatalogueDocumentSchema,
  CoveredReasonSchema,
  StartCatalogueRequestSchema,
  UpgradeSchema,
  type BenefitCatalogue,
  type CatalogueDocument,
  type VariableType,
} from '@astra/contracts';
import {
  AppError,
  canonicalJson,
  conflict,
  forbidden,
  notFound,
  publishEvent,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import { problemsFor, validateCatalogue, type VariableTypes } from '@astra/studio';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';

/** Benefit catalogue (E01-F02-S01/S02/S03). Design: docs/adr/0005. */

interface CatalogueRow {
  id: string;
  schedule_edition_id: string;
  policy_edition_id: string | null;
  version: number;
  status: BenefitCatalogue['status'];
  document: CatalogueDocument;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  contributors: string[];
  approved_by: string | null;
  approved_at: Date | null;
  approval_note: string | null;
}

const EMPTY: CatalogueDocument = { benefits: [], coveredReasons: [], upgrades: [] };
const idParams = z.object({ catalogueId: z.uuid() });
const itemParams = idParams.extend({ code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) });

async function approvedMap(
  tx: Tx,
  editionId: string,
): Promise<{ id: string; types: Map<string, VariableType>; maximums: Map<string, number> } | null> {
  const m = await tx.query<{ id: string }>(
    `SELECT id FROM studio.variable_maps WHERE edition_id = $1 AND status = 'approved'`,
    [editionId],
  );
  if (!m.rows[0]) return null;
  const v = await tx.query<{ key: string; type: VariableType; max: string | null }>(
    `SELECT key, type, constraints ->> 'max' AS max FROM studio.form_variables WHERE map_id = $1`,
    [m.rows[0].id],
  );
  return {
    id: m.rows[0].id,
    types: new Map(v.rows.map((r) => [r.key, r.type])),
    maximums: new Map(
      v.rows
        .filter((r) => r.type === 'numeric_range' && r.max !== null)
        .map((r) => [r.key, Number(r.max)]),
    ),
  };
}

async function mapsFor(
  tx: Tx,
  c: CatalogueRow,
): Promise<VariableTypes & { scheduleMapId: string | null; policyMapId: string | null }> {
  const s = await approvedMap(tx, c.schedule_edition_id);
  const p = c.policy_edition_id ? await approvedMap(tx, c.policy_edition_id) : null;
  const maximums = new Map<string, number>();
  for (const [k, v] of s?.maximums ?? []) maximums.set(`schedule:${k}`, v);
  for (const [k, v] of p?.maximums ?? []) maximums.set(`policy:${k}`, v);
  return {
    schedule: s?.types ?? new Map(),
    policy: c.policy_edition_id ? (p?.types ?? new Map()) : null,
    maximums,
    scheduleMapId: s?.id ?? null,
    policyMapId: p?.id ?? null,
  };
}

async function toCatalogue(tx: Tx, c: CatalogueRow): Promise<BenefitCatalogue> {
  // Approved and superseded versions were checked when approved; drafts are checked against today's maps.
  const problems = c.status === 'draft' ? validateCatalogue(c.document, await mapsFor(tx, c)) : [];
  return {
    id: c.id,
    scheduleEditionId: c.schedule_edition_id,
    policyEditionId: c.policy_edition_id,
    version: c.version,
    status: c.status,
    document: c.document,
    problems,
    createdBy: c.created_by,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
    contributors: c.contributors,
    approvedBy: c.approved_by,
    approvedAt: c.approved_at ? c.approved_at.toISOString() : null,
    approvalNote: c.approval_note,
  };
}

async function findCatalogue(tx: Tx, id: string, lock = false): Promise<CatalogueRow> {
  const { rows } = await tx.query<CatalogueRow>(
    `SELECT * FROM studio.benefit_catalogues WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('The benefit catalogue');
  return rows[0];
}

type Section = 'benefits' | 'coveredReasons' | 'upgrades';

/** Changes one item of a draft and refuses the change if that item now has a problem (peril numbers apart). */
async function editItem(
  tx: Tx,
  subject: string,
  catalogueId: string,
  section: Section,
  code: string,
  item: { code: string } | null,
): Promise<CatalogueRow> {
  const c = await findCatalogue(tx, catalogueId, true);
  if (c.status !== 'draft')
    throw conflict(`Version ${c.version} is ${c.status} and cannot change. Start a new draft.`);
  const list = c.document[section] as { code: string }[];
  const index = list.findIndex((x) => x.code === code);
  if (!item && index < 0) throw notFound('The item');
  const next = item
    ? index >= 0
      ? list.map((x, i) => (i === index ? item : x))
      : [...list, item]
    : list.filter((_, i) => i !== index);
  const doc = CatalogueDocumentSchema.parse({ ...c.document, [section]: next });
  if (item) {
    const bad = problemsFor(validateCatalogue(doc, await mapsFor(tx, c)), `${section}.${code}`);
    if (bad.length) {
      throw new AppError(
        'validation_failed',
        bad[0]!.message,
        bad.map((p) => ({ code: 'invalid_reference', field: p.path, message: p.message })),
      );
    }
  }
  const { rows } = await tx.query<CatalogueRow>(
    `UPDATE studio.benefit_catalogues SET document = $2, updated_at = now(),
            contributors = CASE WHEN $3 = ANY (contributors) THEN contributors ELSE contributors || $3 END
      WHERE id = $1 RETURNING *`,
    [c.id, JSON.stringify(doc), subject],
  );
  return rows[0]!;
}

export const catalogueRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/form-editions/:editionId/catalogues',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Benefit catalogue'],
        summary: 'Benefit catalogue versions built from this schedule edition, newest first',
        params: z.object({ editionId: z.uuid() }),
        response: {
          200: z.object({
            items: z.array(
              BenefitCatalogueSchema.pick({
                id: true,
                version: true,
                status: true,
                createdBy: true,
                approvedBy: true,
                approvedAt: true,
                policyEditionId: true,
              }).extend({
                benefits: z.number().int(),
                coveredReasons: z.number().int(),
                upgrades: z.number().int(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<CatalogueRow>(
          `SELECT * FROM studio.benefit_catalogues WHERE schedule_edition_id = $1 ORDER BY version DESC`,
          [request.params.editionId],
        ),
      );
      return {
        items: rows.map((c) => ({
          id: c.id,
          version: c.version,
          status: c.status,
          createdBy: c.created_by,
          approvedBy: c.approved_by,
          approvedAt: c.approved_at ? c.approved_at.toISOString() : null,
          policyEditionId: c.policy_edition_id,
          benefits: c.document.benefits.length,
          coveredReasons: c.document.coveredReasons.length,
          upgrades: c.document.upgrades.length,
        })),
      };
    },
  );

  app.post(
    '/v1/form-editions/:editionId/catalogues',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      schema: {
        tags: ['Benefit catalogue'],
        summary:
          'Start a draft catalogue for a schedule edition (a copy of the approved catalogue, if there is one)',
        params: z.object({ editionId: z.uuid() }),
        body: StartCatalogueRequestSchema,
        response: { 201: BenefitCatalogueSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const catalogue = await withTx(deps.pool, request.ctx, async (tx) => {
        const { editionId } = request.params;
        const ed = (
          await tx.query<{ kind: string; insurer: string }>(
            `SELECT kind, insurer FROM studio.form_editions WHERE id = $1`,
            [editionId],
          )
        ).rows[0];
        if (!ed) throw notFound('The form edition');
        if (ed.kind !== 'schedule')
          throw new AppError(
            'validation_failed',
            'A benefit catalogue is built from a schedule edition.',
          );
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('catalogue:' || $1))`, [editionId]);
        if (
          (
            await tx.query(
              `SELECT 1 FROM studio.benefit_catalogues WHERE schedule_edition_id = $1 AND status = 'draft'`,
              [editionId],
            )
          ).rowCount
        ) {
          throw conflict('This schedule already has a draft catalogue. Continue that one.');
        }
        const current = (
          await tx.query<CatalogueRow>(
            `SELECT * FROM studio.benefit_catalogues WHERE schedule_edition_id = $1 AND status = 'approved'`,
            [editionId],
          )
        ).rows[0];
        let policyId =
          request.body.policyEditionId === undefined
            ? (current?.policy_edition_id ?? null)
            : request.body.policyEditionId;
        if (policyId) {
          const pol = (
            await tx.query<{ kind: string; insurer: string }>(
              `SELECT kind, insurer FROM studio.form_editions WHERE id = $1`,
              [policyId],
            )
          ).rows[0];
          if (!pol) throw notFound('The policy form edition');
          if (pol.kind !== 'policy')
            throw new AppError(
              'validation_failed',
              'The policy form edition must be a policy form.',
            );
          if (pol.insurer !== ed.insurer)
            throw new AppError(
              'validation_failed',
              `The schedule is a ${ed.insurer} form; the policy form is ${pol.insurer}.`,
            );
        } else policyId = null;
        if (!(await approvedMap(tx, editionId))) {
          throw new AppError(
            'precondition_failed',
            'Approve the schedule’s variable map first: the catalogue refers to its variables.',
          );
        }
        const next = await tx.query<{ n: number }>(
          `SELECT coalesce(max(version), 0) + 1 AS n FROM studio.benefit_catalogues WHERE schedule_edition_id = $1`,
          [editionId],
        );
        const row = (
          await tx.query<CatalogueRow>(
            `INSERT INTO studio.benefit_catalogues (schedule_edition_id, policy_edition_id, version, document, created_by, contributors)
             VALUES ($1, $2, $3, $4, $5, ARRAY[$5]) RETURNING *`,
            [
              editionId,
              policyId,
              next.rows[0]!.n,
              JSON.stringify(current?.document ?? EMPTY),
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'benefit_catalogue.draft_started',
          resourceType: 'benefit_catalogue',
          resourceId: row.id,
          data: { scheduleEditionId: editionId, policyEditionId: policyId, version: row.version },
        });
        return toCatalogue(tx, row);
      });
      return reply.code(201).send(catalogue);
    },
  );

  app.get(
    '/v1/benefit-catalogues/:catalogueId',
    {
      config: { tenancy: 'platform', permission: 'forms:read' },
      schema: {
        tags: ['Benefit catalogue'],
        summary: 'Get a catalogue version, with any problems that block its approval',
        params: idParams,
        response: { 200: BenefitCatalogueSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) =>
        toCatalogue(tx, await findCatalogue(tx, request.params.catalogueId)),
      ),
  );

  const sections: {
    path: string;
    section: Section;
    schema: z.ZodType<{ code: string }>;
    tag: string;
  }[] = [
    { path: 'benefits', section: 'benefits', schema: BenefitSchema, tag: 'benefit' },
    {
      path: 'covered-reasons',
      section: 'coveredReasons',
      schema: CoveredReasonSchema,
      tag: 'covered reason',
    },
    { path: 'upgrades', section: 'upgrades', schema: UpgradeSchema, tag: 'upgrade' },
  ];
  for (const s of sections) {
    app.put(
      `/v1/benefit-catalogues/:catalogueId/${s.path}/:code`,
      {
        config: { tenancy: 'platform', permission: 'forms:manage' },
        schema: {
          tags: ['Benefit catalogue'],
          summary: `Add or replace a ${s.tag} in a draft catalogue`,
          params: itemParams,
          body: s.schema,
          response: { 200: BenefitCatalogueSchema, ...commonErrors },
        },
      },
      async (request) =>
        withTx(deps.pool, request.ctx, async (tx) => {
          const item = request.body as { code: string };
          if (item.code !== request.params.code) {
            throw new AppError(
              'validation_failed',
              'The code in the body must match the address.',
              [{ code: 'code_mismatch', field: 'code', message: 'Must match the URL' }],
            );
          }
          return toCatalogue(
            tx,
            await editItem(
              tx,
              request.ctx.principal.subject,
              request.params.catalogueId,
              s.section,
              item.code,
              item,
            ),
          );
        }),
    );
    app.delete(
      `/v1/benefit-catalogues/:catalogueId/${s.path}/:code`,
      {
        config: { tenancy: 'platform', permission: 'forms:manage' },
        schema: {
          tags: ['Benefit catalogue'],
          summary: `Remove a ${s.tag} from a draft catalogue`,
          params: itemParams,
          response: { 200: BenefitCatalogueSchema, ...commonErrors },
        },
      },
      async (request) =>
        withTx(deps.pool, request.ctx, async (tx) =>
          toCatalogue(
            tx,
            await editItem(
              tx,
              request.ctx.principal.subject,
              request.params.catalogueId,
              s.section,
              request.params.code,
              null,
            ),
          ),
        ),
    );
  }

  app.post(
    '/v1/benefit-catalogues/:catalogueId/approve',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      schema: {
        tags: ['Benefit catalogue'],
        summary:
          'Approve a draft catalogue (by someone who did not build it); it replaces the current one',
        params: idParams,
        body: z.object({ note: z.string().trim().min(5).max(500) }),
        response: { 200: BenefitCatalogueSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const c = await findCatalogue(tx, request.params.catalogueId, true);
        if (c.status !== 'draft') throw conflict(`Version ${c.version} is already ${c.status}.`);
        if (c.contributors.includes(request.ctx.principal.subject)) {
          throw forbidden(
            'A benefit catalogue must be approved by someone who did not create or edit it.',
          );
        }
        if (c.document.benefits.length === 0)
          throw new AppError('precondition_failed', 'The catalogue has no benefits yet.');
        const maps = await mapsFor(tx, c);
        const problems = validateCatalogue(c.document, maps);
        if (problems.length) {
          throw new AppError(
            'precondition_failed',
            `${problems.length} problem${problems.length === 1 ? '' : 's'} must be resolved before approval.`,
            problems
              .slice(0, 100)
              .map((p) => ({ code: 'catalogue_problem', field: p.path, message: p.message })),
          );
        }
        await tx.query(
          `UPDATE studio.benefit_catalogues SET status = 'superseded' WHERE schedule_edition_id = $1 AND status = 'approved'`,
          [c.schedule_edition_id],
        );
        const sha256 = createHash('sha256').update(canonicalJson(c.document)).digest('hex');
        const row = (
          await tx.query<CatalogueRow>(
            `UPDATE studio.benefit_catalogues SET status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3,
                    sha256 = $4, schedule_map_id = $5, policy_map_id = $6
              WHERE id = $1 RETURNING *`,
            [
              c.id,
              request.ctx.principal.subject,
              request.body.note,
              sha256,
              maps.scheduleMapId,
              maps.policyMapId,
            ],
          )
        ).rows[0]!;
        const counts = {
          benefits: c.document.benefits.length,
          coveredReasons: c.document.coveredReasons.length,
          upgrades: c.document.upgrades.length,
        };
        await publishEvent(
          tx,
          request.ctx,
          BenefitCatalogueApproved,
          {
            catalogueId: row.id,
            scheduleEditionId: row.schedule_edition_id,
            version: row.version,
            ...counts,
          },
          { accountId: null },
        );
        await writeAudit(tx, request.ctx, {
          action: 'benefit_catalogue.approved',
          resourceType: 'benefit_catalogue',
          resourceId: row.id,
          reason: request.body.note,
          data: {
            version: row.version,
            sha256,
            scheduleMapId: maps.scheduleMapId,
            policyMapId: maps.policyMapId,
            contributors: row.contributors,
            ...counts,
          },
        });
        return toCatalogue(tx, row);
      }),
  );

  app.delete(
    '/v1/benefit-catalogues/:catalogueId',
    {
      config: { tenancy: 'platform', permission: 'forms:manage' },
      schema: {
        tags: ['Benefit catalogue'],
        summary: 'Discard a draft catalogue',
        params: idParams,
        response: { 204: z.null(), ...commonErrors },
      },
    },
    async (request, reply) => {
      await withTx(deps.pool, request.ctx, async (tx) => {
        const c = await findCatalogue(tx, request.params.catalogueId, true);
        if (c.status !== 'draft') throw conflict('Only a draft catalogue can be discarded.');
        await tx.query(`DELETE FROM studio.benefit_catalogues WHERE id = $1`, [c.id]);
        await writeAudit(tx, request.ctx, {
          action: 'benefit_catalogue.discarded',
          resourceType: 'benefit_catalogue',
          resourceId: c.id,
          data: { version: c.version },
        });
      });
      return reply.code(204).send(null);
    },
  );
};
