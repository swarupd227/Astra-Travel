import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  ApprovalAnswerSchema,
  ChangeFilingStatusRequestSchema,
  CreateFilingRequestSchema,
  FILING_ITEM_TYPES,
  FILING_STATUSES,
  FILING_TRANSITIONS,
  FilingEventSchema,
  FilingSchema,
  FilingStatusChanged,
  pageOf,
  PageQuerySchema,
  type Filing,
  type FilingStatus,
} from '@astra/contracts';
import {
  AppError,
  conflict,
  decodeCursor,
  encodeCursor,
  isUniqueViolation,
  notFound,
  publishEvent,
  withIdempotency,
  withTx,
  writeAudit,
  type RequestContext,
  type Tx,
} from '@astra/platform';
import { approvalFor, keysInForce, type FilingRow } from '@astra/studio';
import type { AppDeps } from '../app';
import { commonErrors, idempotencyHeaders, idempotencyKey } from './shared';

/** The filing register (E10-F01-S01) and the approval check (E10-F01-S02). */

export const toFiling = (r: FilingRow): Filing => ({
  id: r.id,
  state: r.state,
  insurer: r.insurer as Filing['insurer'],
  itemType: r.item_type,
  itemId: r.item_id,
  itemReference: r.item_reference,
  serffTracking: r.serff_tracking,
  status: r.status as FilingStatus,
  submittedOn: r.submitted_on,
  decidedOn: r.decided_on,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const today = () => new Date().toISOString().slice(0, 10);

/** State codes must be in the US states reference data in force today. */
export async function assertStates(tx: Tx, states: string[]): Promise<void> {
  const known = await keysInForce(tx, 'us_states', today());
  if (!known) {
    throw new AppError(
      'precondition_failed',
      'Approve the US states reference data first: filings are recorded by state.',
    );
  }
  const unknown = states.filter((s) => !known.has(s));
  if (unknown.length) {
    throw new AppError(
      'validation_failed',
      `Unknown state code${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
      [
        {
          code: 'unknown_state',
          field: 'states',
          message: `Not in the US states reference data: ${unknown.join(', ')}`,
        },
      ],
    );
  }
}

async function recordEvent(
  tx: Tx,
  ctx: RequestContext,
  filing: FilingRow,
  from: string | null,
  reason: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO compliance.filing_events (filing_id, actor, from_status, to_status, reason, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      filing.id,
      ctx.principal.subject,
      from,
      filing.status,
      reason,
      JSON.stringify({
        effectiveFrom: filing.effective_from,
        effectiveTo: filing.effective_to,
        serff: filing.serff_tracking,
      }),
    ],
  );
  await publishEvent(
    tx,
    ctx,
    FilingStatusChanged,
    {
      filingId: filing.id,
      state: filing.state,
      itemType: filing.item_type,
      itemReference: filing.item_reference,
      from,
      to: filing.status,
      effectiveFrom: filing.effective_from,
    },
    { accountId: null },
  );
}

export const filingRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/filings',
    {
      config: { tenancy: 'platform', permission: 'filings:read' },
      schema: {
        tags: ['Compliance'],
        summary: 'Search the filing register',
        querystring: PageQuerySchema.extend({
          state: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
          status: z.enum(FILING_STATUSES).optional(),
          itemType: z.enum(FILING_ITEM_TYPES).optional(),
          itemId: z.uuid().optional(),
          q: z.string().trim().min(1).max(100).optional(),
        }),
        response: { 200: pageOf(FilingSchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, state, status, itemType, itemId, q } = request.query;
      const after = decodeCursor(cursor, 3);
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<FilingRow>(
          `SELECT * FROM compliance.filings
            WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR status = $2)
              AND ($3::text IS NULL OR item_type = $3) AND ($4::uuid IS NULL OR item_id = $4)
              AND ($5::text IS NULL OR item_reference ILIKE '%' || $5 || '%' OR serff_tracking ILIKE '%' || $5 || '%')
              AND ($6::text IS NULL OR (item_reference, state, id) > ($6, $7, $8::uuid))
            ORDER BY item_reference, state, id LIMIT $9`,
          [
            state ?? null,
            status ?? null,
            itemType ?? null,
            itemId ?? null,
            q ?? null,
            after?.[0] ?? null,
            after?.[1] ?? null,
            after?.[2] ?? null,
            limit + 1,
          ],
        ),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toFiling),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor([last.item_reference, last.state, last.id])
            : null,
      };
    },
  );

  app.post(
    '/v1/filings',
    {
      config: { tenancy: 'platform', permission: 'filings:manage' },
      schema: {
        tags: ['Compliance'],
        summary:
          'Record a filing of a form, manual or rule set in one or more states (one filing per state, in draft)',
        headers: idempotencyHeaders,
        body: CreateFilingRequestSchema,
        response: { 201: z.object({ items: z.array(FilingSchema) }), ...commonErrors },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const result = await withTx(deps.pool, request.ctx, (tx) =>
        withIdempotency(
          tx,
          request.ctx,
          {
            key: idempotencyKey(request),
            method: 'POST',
            path: '/v1/filings',
            body,
            accountId: null,
          },
          async () => {
            const states = [...new Set(body.states)].sort();
            await assertStates(tx, states);
            let reference = body.itemReference ?? '';
            if (body.itemType === 'form_edition') {
              const ed = (
                await tx.query<{ form_number: string; edition: string; insurer: string }>(
                  `SELECT form_number, edition, insurer FROM studio.form_editions WHERE id = $1`,
                  [body.itemId],
                )
              ).rows[0];
              if (!ed) throw notFound('The form edition');
              if (ed.insurer !== body.insurer) {
                throw new AppError(
                  'validation_failed',
                  `The form edition is issued by ${ed.insurer}, not ${body.insurer}.`,
                  [
                    {
                      code: 'insurer_mismatch',
                      field: 'insurer',
                      message: `The form is a ${ed.insurer} form`,
                    },
                  ],
                );
              }
              reference = `${ed.form_number} ed. ${ed.edition}`;
            }
            const created: FilingRow[] = [];
            for (const state of states) {
              const row = (
                await tx.query<FilingRow>(
                  `INSERT INTO compliance.filings (state, insurer, item_type, item_id, item_reference, serff_tracking, notes, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                  [
                    state,
                    body.insurer,
                    body.itemType,
                    body.itemId ?? null,
                    reference,
                    body.serffTracking ?? null,
                    body.notes ?? null,
                    request.ctx.principal.subject,
                  ],
                )
              ).rows[0]!;
              await recordEvent(tx, request.ctx, row, null, null);
              created.push(row);
            }
            await writeAudit(tx, request.ctx, {
              action: 'filing.recorded',
              resourceType: 'filing',
              resourceId: created.length === 1 ? created[0]!.id : null,
              data: {
                itemType: body.itemType,
                itemReference: reference,
                insurer: body.insurer,
                states,
                filings: created.map((c) => c.id),
              },
            });
            return { status: 201, body: { items: created.map(toFiling) } };
          },
        ),
      );
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(201).send(result.body);
    },
  );

  app.get(
    '/v1/filings/approval',
    {
      config: { tenancy: 'platform', permission: 'filings:read' },
      schema: {
        tags: ['Compliance'],
        summary: 'May this form, manual or rule set be used in a state on a date? (E10-F01-S02)',
        querystring: z
          .object({
            itemType: z.enum(FILING_ITEM_TYPES),
            itemId: z.uuid().optional(),
            itemReference: z.string().max(200).optional(),
            state: z.string().regex(/^[A-Z]{2}$/),
            date: z.iso.date().optional(),
          })
          .refine((v) => (v.itemType === 'form_edition' ? !!v.itemId : !!v.itemReference), {
            message: 'Give itemId for a form edition, or itemReference for a manual or rule set',
            path: ['itemId'],
          }),
        response: { 200: ApprovalAnswerSchema, ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const answer = await withTx(deps.pool, request.ctx, (tx) =>
        approvalFor(
          tx,
          q.itemType === 'form_edition'
            ? { itemType: 'form_edition', itemId: q.itemId! }
            : { itemType: q.itemType, itemReference: q.itemReference! },
          q.state,
          q.date ?? today(),
        ),
      );
      return {
        approved: answer.approved,
        reason: answer.reason,
        filing: answer.filing ? toFiling(answer.filing) : null,
      };
    },
  );

  app.get(
    '/v1/filings/:filingId',
    {
      config: { tenancy: 'platform', permission: 'filings:read' },
      schema: {
        tags: ['Compliance'],
        summary: 'Get a filing and its status history',
        params: z.object({ filingId: z.uuid() }),
        response: {
          200: FilingSchema.extend({ history: z.array(FilingEventSchema) }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const row = (
          await tx.query<FilingRow>(`SELECT * FROM compliance.filings WHERE id = $1`, [
            request.params.filingId,
          ])
        ).rows[0];
        if (!row) throw notFound('The filing');
        const events = await tx.query<{
          at: Date;
          actor: string;
          from_status: string | null;
          to_status: string;
          reason: string | null;
        }>(
          `SELECT at, actor, from_status, to_status, reason FROM compliance.filing_events WHERE filing_id = $1 ORDER BY id`,
          [row.id],
        );
        return {
          ...toFiling(row),
          history: events.rows.map((e) => ({
            at: e.at.toISOString(),
            actor: e.actor,
            fromStatus: e.from_status,
            toStatus: e.to_status,
            reason: e.reason,
          })),
        };
      }),
  );

  app.post(
    '/v1/filings/:filingId/status',
    {
      config: { tenancy: 'platform', permission: 'filings:manage' },
      schema: {
        tags: ['Compliance'],
        summary: 'Record a submission, the regulator’s decision, or a withdrawal',
        params: z.object({ filingId: z.uuid() }),
        body: ChangeFilingStatusRequestSchema,
        response: { 200: FilingSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const current = (
          await tx.query<FilingRow>(`SELECT * FROM compliance.filings WHERE id = $1 FOR UPDATE`, [
            request.params.filingId,
          ])
        ).rows[0];
        if (!current) throw notFound('The filing');
        const from = current.status as FilingStatus;
        const b = request.body;
        if (!FILING_TRANSITIONS[from].includes(b.status)) {
          throw conflict(`A ${from} filing cannot become ${b.status}.`);
        }
        if (b.status === 'approved' && current.submitted_on && b.on < current.submitted_on) {
          throw new AppError(
            'validation_failed',
            'The decision date cannot be before the submission date.',
            [
              {
                code: 'before_submission',
                field: 'on',
                message: `Submitted on ${current.submitted_on}`,
              },
            ],
          );
        }
        let row: FilingRow;
        try {
          row = (
            await tx.query<FilingRow>(
              `UPDATE compliance.filings SET
                  status = $2,
                  submitted_on = CASE WHEN $2 = 'submitted' THEN $3::date ELSE submitted_on END,
                  decided_on = CASE WHEN $2 IN ('approved', 'disapproved') THEN $3::date ELSE decided_on END,
                  -- Withdrawing an approval ends it on the withdrawal date (never later than it already
                  -- ended). Withdrawn before it took effect, it was never in force.
                  effective_from = CASE
                    WHEN $2 = 'approved' THEN $4::date
                    WHEN $2 = 'withdrawn' AND effective_from IS NOT NULL AND $3::date <= effective_from THEN NULL
                    ELSE effective_from END,
                  effective_to = CASE
                    WHEN $2 = 'approved' THEN $5::date
                    WHEN $2 = 'withdrawn' AND effective_from IS NOT NULL AND $3::date <= effective_from THEN NULL
                    WHEN $2 = 'withdrawn' AND effective_from IS NOT NULL
                      THEN LEAST(coalesce(effective_to, 'infinity'::date), $3::date)
                    ELSE effective_to END,
                  serff_tracking = coalesce($6, serff_tracking),
                  updated_at = now()
                WHERE id = $1 RETURNING *`,
              [
                current.id,
                b.status,
                b.on,
                b.effectiveFrom ?? null,
                b.effectiveTo ?? null,
                b.serffTracking ?? null,
              ],
            )
          ).rows[0]!;
        } catch (err) {
          if ((err as { code?: string }).code === '23P01') {
            throw conflict(
              `Another approval for ${current.item_reference} in ${current.state} already covers these dates.`,
            );
          }
          if (isUniqueViolation(err)) throw conflict('That change conflicts with another filing.');
          throw err;
        }
        await recordEvent(tx, request.ctx, row, from, b.reason);
        await writeAudit(tx, request.ctx, {
          action: `filing.${b.status}`,
          resourceType: 'filing',
          resourceId: row.id,
          reason: b.reason,
          data: {
            from,
            to: b.status,
            state: row.state,
            item: row.item_reference,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            serff: row.serff_tracking,
          },
        });
        return toFiling(row);
      }),
  );
};
