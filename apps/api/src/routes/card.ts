import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  CardProgrammeRegistered,
  CardProgrammeSchema,
  CardProgrammeStatusChanged,
  ChangeProgrammeStatusRequestSchema,
  CoverVerificationRequestSchema,
  CoverVerificationSchema,
  CreateCardProgrammeRequestSchema,
  CreateMasterPolicyRequestSchema,
  EligibilityAnswerSchema,
  EligibilityCheckRequestSchema,
  EligibilityFeedReceived,
  EligibilityFeedSchema,
  FEED_MODES,
  FEED_STATUSES,
  FeedRejectionSchema,
  GoLiveRequestSchema,
  MasterPolicyRegistered,
  MasterPolicySchema,
  pageOf,
  PageQuerySchema,
  PROGRAMME_STATUS_TRANSITIONS,
  PROGRAMME_STATUSES,
  RejectFeedRequestSchema,
  type CardProgramme,
  type EligibilityFeed,
  type FeedStats,
  type MasterPolicy,
  type PaymentCondition,
} from '@astra/contracts';
import {
  AppError,
  conflict,
  decodeCursor,
  encodeCursor,
  FileTooLargeError,
  isUniqueViolation,
  notFound,
  preconditionFailed,
  publishEvent,
  withIdempotency,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import { assertNotCardNumber, eligibilityOn, loadProgrammeById, verifyCover } from '@astra/card';
import type { AppDeps } from '../app';
import { commonErrors, idempotencyHeaders, idempotencyKey } from './shared';

/** Card-linked cover (E21): master policies, card programmes, eligibility feeds and cover checks. */

interface MasterPolicyRow {
  id: string;
  account_id: string;
  policy_number: string;
  underwriter: string;
  states: string[];
  effective_from: string;
  effective_to: string | null;
  status: 'active' | 'cancelled';
  created_at: Date;
}

const toMasterPolicy = (r: MasterPolicyRow): MasterPolicy => ({
  id: r.id,
  accountId: r.account_id,
  policyNumber: r.policy_number,
  underwriter: r.underwriter,
  states: r.states,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  status: r.status,
  createdAt: r.created_at.toISOString(),
});

interface ProgrammeRow {
  id: string;
  account_id: string;
  account_name: string;
  code: string;
  name: string;
  card_product: string;
  master_policy_id: string;
  master_policy_number: string;
  states: string[];
  effective_from: string;
  effective_to: string | null;
  payment_condition: PaymentCondition;
  eligibility_rule: CardProgramme['eligibilityRule'];
  max_reject_percent: string;
  status: CardProgramme['status'];
  last_applied_sequence: number;
  accounts_on_file: number;
  certificates_issued: number;
  created_at: Date;
  updated_at: Date;
}

// Counts come from the programme (kept when feeds are applied); lists never count the ledger.
const PROGRAMME_SELECT = `
  SELECT p.*, a.name AS account_name, m.policy_number AS master_policy_number
    FROM card.programmes p
    JOIN platform.accounts a ON a.id = p.account_id
    JOIN card.master_policies m ON m.id = p.master_policy_id`;

const toProgramme = (r: ProgrammeRow): CardProgramme => ({
  id: r.id,
  accountId: r.account_id,
  accountName: r.account_name,
  code: r.code,
  name: r.name,
  cardProduct: r.card_product,
  masterPolicyId: r.master_policy_id,
  masterPolicyNumber: r.master_policy_number,
  states: r.states,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  paymentCondition: r.payment_condition,
  eligibilityRule: r.eligibility_rule,
  maxRejectPercent: Number(r.max_reject_percent),
  status: r.status,
  lastAppliedSequence: r.last_applied_sequence,
  accountsOnFile: r.accounts_on_file,
  certificates: r.certificates_issued,
  eligibleToday: null,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

interface FeedRow {
  id: string;
  programme_id: string;
  account_id: string;
  mode: EligibilityFeed['mode'];
  sequence: number | null;
  kind: EligibilityFeed['kind'];
  as_of_date: string | null;
  file_name: string;
  sha256: string;
  size_bytes: string;
  status: EligibilityFeed['status'];
  status_reason: string | null;
  stats: FeedStats | null;
  received_at: Date;
  received_by: string;
  processed_at: Date | null;
  duration_ms: number | null;
}

const FEED_COLUMNS = `id, programme_id, account_id, mode, sequence, kind, as_of_date, file_name, sha256, size_bytes,
  status, status_reason, stats, received_at, received_by, processed_at, duration_ms`;

const toFeed = (r: FeedRow): EligibilityFeed => ({
  id: r.id,
  programmeId: r.programme_id,
  mode: r.mode,
  sequence: r.sequence,
  kind: r.kind,
  asOfDate: r.as_of_date,
  fileName: r.file_name,
  sha256: r.sha256,
  sizeBytes: Number(r.size_bytes),
  status: r.status,
  statusReason: r.status_reason,
  stats: r.stats,
  receivedAt: r.received_at.toISOString(),
  receivedBy: r.received_by,
  processedAt: r.processed_at ? r.processed_at.toISOString() : null,
  durationMs: r.duration_ms,
});

async function findProgramme(tx: Tx, id: string): Promise<ProgrammeRow> {
  const { rows } = await tx.query<ProgrammeRow>(`${PROGRAMME_SELECT} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw notFound('The card programme');
  return rows[0];
}

async function findFeed(
  tx: Tx,
  programmeId: string,
  feedId: string,
  lock = false,
): Promise<FeedRow> {
  const { rows } = await tx.query<FeedRow>(
    `SELECT ${FEED_COLUMNS} FROM card.feeds WHERE id = $1 AND programme_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [feedId, programmeId],
  );
  if (!rows[0]) throw notFound('The eligibility feed');
  return rows[0];
}

const programmeParams = z.object({ programmeId: z.uuid() });
const feedParams = z.object({ programmeId: z.uuid(), feedId: z.uuid() });
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,199}$/;

export const cardRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // Feed files are streamed straight to storage, never buffered (scoped to this plugin's routes).
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload),
  );

  // ---------------- Master policies ----------------

  app.get(
    '/v1/master-policies',
    {
      config: { tenancy: 'platform', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'List master policies',
        querystring: z.object({ accountId: z.uuid().optional() }),
        response: { 200: z.object({ items: z.array(MasterPolicySchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<MasterPolicyRow>(
          `SELECT * FROM card.master_policies WHERE ($1::uuid IS NULL OR account_id = $1)
            ORDER BY policy_number LIMIT 500`,
          [request.query.accountId ?? null],
        ),
      );
      return { items: rows.map(toMasterPolicy) };
    },
  );

  app.post(
    '/v1/master-policies',
    {
      config: { tenancy: 'platform', permission: 'card:manage' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Register the master policy issued to a card issuer or bank',
        headers: idempotencyHeaders,
        body: CreateMasterPolicyRequestSchema,
        response: { 201: MasterPolicySchema, ...commonErrors },
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
            path: '/v1/master-policies',
            body,
            accountId: body.accountId,
          },
          async () => {
            const account = await tx.query<{ kind: string; status: string }>(
              `SELECT kind, status FROM platform.accounts WHERE id = $1`,
              [body.accountId],
            );
            if (!account.rows[0]) throw notFound('The account');
            if (account.rows[0].kind === 'travel_account') {
              throw new AppError(
                'validation_failed',
                'Master policies are issued to card issuers and banks.',
                [
                  {
                    field: 'accountId',
                    code: 'account_kind',
                    message: 'Choose a card issuer or bank account',
                  },
                ],
              );
            }
            if (account.rows[0].status === 'closed') throw conflict('The account is closed.');
            let row: MasterPolicyRow;
            try {
              row = (
                await tx.query<MasterPolicyRow>(
                  `INSERT INTO card.master_policies
                     (account_id, policy_number, underwriter, states, effective_from, effective_to, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                  [
                    body.accountId,
                    body.policyNumber,
                    body.underwriter,
                    [...new Set(body.states)].sort(),
                    body.effectiveFrom,
                    body.effectiveTo ?? null,
                    request.ctx.principal.subject,
                  ],
                )
              ).rows[0]!;
            } catch (err) {
              if (isUniqueViolation(err)) {
                throw new AppError(
                  'conflict',
                  `Master policy ${body.policyNumber} already exists.`,
                  [
                    {
                      field: 'policyNumber',
                      code: 'duplicate',
                      message: 'This policy number is already registered.',
                    },
                  ],
                );
              }
              throw err;
            }
            await publishEvent(
              tx,
              request.ctx,
              MasterPolicyRegistered,
              {
                masterPolicyId: row.id,
                policyNumber: row.policy_number,
                underwriter: row.underwriter,
              },
              { accountId: row.account_id },
            );
            await writeAudit(tx, request.ctx, {
              action: 'master_policy.registered',
              resourceType: 'master_policy',
              resourceId: row.id,
              accountId: row.account_id,
              data: {
                policyNumber: row.policy_number,
                underwriter: row.underwriter,
                states: row.states,
              },
            });
            return { status: 201, body: toMasterPolicy(row) };
          },
        ),
      );
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(201).send(result.body);
    },
  );

  // ---------------- Programmes ----------------

  app.get(
    '/v1/card-programmes',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'List the card programmes you can see',
        querystring: PageQuerySchema.extend({
          status: z.enum(PROGRAMME_STATUSES).optional(),
          accountId: z.uuid().optional(),
        }),
        response: { 200: pageOf(CardProgrammeSchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, status, accountId } = request.query;
      const after = decodeCursor(cursor, 1);
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<ProgrammeRow>(
          `${PROGRAMME_SELECT}
            WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.account_id = $2)
              AND ($3::text IS NULL OR p.code > $3)
            ORDER BY p.code LIMIT $4`,
          [status ?? null, accountId ?? null, after?.[0] ?? null, limit + 1],
        ),
      );
      const page = rows.slice(0, limit);
      return {
        items: page.map(toProgramme),
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.code]) : null,
      };
    },
  );

  app.post(
    '/v1/card-programmes',
    {
      config: { tenancy: 'platform', permission: 'card:manage' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Set up a card programme under a master policy (starts in draft)',
        headers: idempotencyHeaders,
        body: CreateCardProgrammeRequestSchema,
        response: { 201: CardProgrammeSchema, ...commonErrors },
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
            path: '/v1/card-programmes',
            body,
            accountId: null,
          },
          async () => {
            const policy = (
              await tx.query<MasterPolicyRow>(`SELECT * FROM card.master_policies WHERE id = $1`, [
                body.masterPolicyId,
              ])
            ).rows[0];
            if (!policy) throw notFound('The master policy');
            if (policy.status !== 'active') throw conflict('The master policy is cancelled.');
            const outside = body.states.filter((s) => !policy.states.includes(s));
            if (outside.length) {
              throw new AppError(
                'validation_failed',
                'A programme can only cover states its master policy covers.',
                [
                  {
                    field: 'states',
                    code: 'outside_master_policy',
                    message: `Not on the master policy: ${outside.join(', ')}`,
                  },
                ],
              );
            }
            if (
              body.effectiveFrom < policy.effective_from ||
              (policy.effective_to && (!body.effectiveTo || body.effectiveTo > policy.effective_to))
            ) {
              throw new AppError(
                'validation_failed',
                'The programme dates must fall within the master policy dates.',
                [
                  {
                    field: 'effectiveFrom',
                    code: 'outside_master_policy',
                    message: `The master policy runs from ${policy.effective_from}${policy.effective_to ? ` to ${policy.effective_to}` : ''}`,
                  },
                ],
              );
            }
            let id: string;
            try {
              id = (
                await tx.query<{ id: string }>(
                  `INSERT INTO card.programmes
                     (account_id, master_policy_id, code, name, card_product, states, effective_from, effective_to,
                      payment_condition, eligibility_rule, max_reject_percent, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
                  [
                    policy.account_id,
                    policy.id,
                    body.code,
                    body.name,
                    body.cardProduct,
                    [...new Set(body.states)].sort(),
                    body.effectiveFrom,
                    body.effectiveTo ?? null,
                    JSON.stringify(body.paymentCondition),
                    body.eligibilityRule,
                    body.maxRejectPercent,
                    request.ctx.principal.subject,
                  ],
                )
              ).rows[0]!.id;
            } catch (err) {
              if (isUniqueViolation(err)) {
                throw new AppError(
                  'conflict',
                  `A programme with code ${body.code} already exists.`,
                  [{ field: 'code', code: 'duplicate', message: 'This code is already used.' }],
                );
              }
              throw err;
            }
            await publishEvent(
              tx,
              request.ctx,
              CardProgrammeRegistered,
              { programmeId: id, code: body.code, masterPolicyId: policy.id },
              { accountId: policy.account_id },
            );
            await writeAudit(tx, request.ctx, {
              action: 'card_programme.registered',
              resourceType: 'card_programme',
              resourceId: id,
              accountId: policy.account_id,
              data: {
                code: body.code,
                masterPolicy: policy.policy_number,
                paymentCondition: body.paymentCondition,
                eligibilityRule: body.eligibilityRule,
              },
            });
            return { status: 201, body: toProgramme(await findProgramme(tx, id)) };
          },
        ),
      );
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply
        .code(201)
        .header('location', `/v1/card-programmes/${result.body.id}`)
        .send(result.body);
    },
  );

  app.get(
    '/v1/card-programmes/:programmeId',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Get a card programme',
        params: programmeParams,
        response: { 200: CardProgrammeSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const p = await findProgramme(tx, request.params.programmeId);
        // Exact for one programme, from the partial index on current periods.
        const today = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM card.eligibility_periods
            WHERE programme_id = $1 AND ended_by IS NULL AND valid_from <= current_date
              AND (valid_to IS NULL OR valid_to > current_date)`,
          [p.id],
        );
        return { ...toProgramme(p), eligibleToday: Number(today.rows[0]!.n) };
      }),
  );

  async function changeStatus(
    tx: Tx,
    request: { ctx: Parameters<typeof writeAudit>[1] },
    programme: ProgrammeRow,
    to: CardProgramme['status'],
    reason: string,
    action: string,
  ): Promise<CardProgramme> {
    await tx.query(
      `UPDATE card.programmes SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1`,
      [programme.id, to, reason],
    );
    await publishEvent(
      tx,
      request.ctx,
      CardProgrammeStatusChanged,
      { programmeId: programme.id, from: programme.status, to, reason },
      { accountId: programme.account_id },
    );
    await writeAudit(tx, request.ctx, {
      action,
      resourceType: 'card_programme',
      resourceId: programme.id,
      accountId: programme.account_id,
      reason,
      data: { from: programme.status, to },
    });
    return toProgramme(await findProgramme(tx, programme.id));
  }

  app.post(
    '/v1/card-programmes/:programmeId/go-live',
    {
      config: { tenancy: 'platform', permission: 'card:manage' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Take a draft programme live once a test feed has passed (E21-F01-S02)',
        params: programmeParams,
        body: GoLiveRequestSchema,
        response: { 200: CardProgrammeSchema, ...commonErrors, 412: z.any() },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const programme = await findProgramme(tx, request.params.programmeId);
        await tx.query(`SELECT 1 FROM card.programmes WHERE id = $1 FOR UPDATE`, [programme.id]);
        if (programme.status !== 'draft')
          throw conflict(`The programme is already ${programme.status}.`);
        const passed = await tx.query(
          `SELECT 1 FROM card.feeds WHERE programme_id = $1 AND mode = 'test' AND status = 'passed' LIMIT 1`,
          [programme.id],
        );
        if (!passed.rowCount) {
          throw preconditionFailed(
            'A programme goes live only after a test feed from the issuer has passed. Upload a test feed first.',
          );
        }
        const policy = await tx.query<{ status: string }>(
          `SELECT status FROM card.master_policies WHERE id = $1`,
          [programme.master_policy_id],
        );
        if (policy.rows[0]?.status !== 'active')
          throw preconditionFailed('The master policy is not active.');
        return changeStatus(
          tx,
          request,
          programme,
          'live',
          request.body.reason,
          'card_programme.went_live',
        );
      }),
  );

  app.post(
    '/v1/card-programmes/:programmeId/status',
    {
      config: { tenancy: 'platform', permission: 'card:manage' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Suspend, resume or close a card programme',
        params: programmeParams,
        body: ChangeProgrammeStatusRequestSchema,
        response: { 200: CardProgrammeSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const programme = await findProgramme(tx, request.params.programmeId);
        await tx.query(`SELECT 1 FROM card.programmes WHERE id = $1 FOR UPDATE`, [programme.id]);
        const { status: to, reason } = request.body;
        if (programme.status === to) return toProgramme(programme);
        if (!PROGRAMME_STATUS_TRANSITIONS[programme.status].includes(to)) {
          throw conflict(
            programme.status === 'draft' && to === 'live'
              ? 'A draft programme goes live through go-live, after a test feed has passed.'
              : `A programme cannot move from ${programme.status} to ${to}.`,
          );
        }
        return changeStatus(tx, request, programme, to, reason, 'card_programme.status_changed');
      }),
  );

  // ---------------- Eligibility feeds ----------------

  app.post(
    '/v1/card-programmes/:programmeId/feeds',
    {
      config: { tenancy: 'account', permission: 'card:feeds' },
      bodyLimit: deps.config.CARD_FEED_MAX_BYTES,
      schema: {
        tags: ['Card-linked cover'],
        summary:
          'Upload an eligibility feed file (format: docs/integration/eligibility-feed-v1.md)',
        description:
          'Send the file as the request body with content type application/octet-stream. Each file is accepted ' +
          'once per mode: uploading the same file again returns the original feed with status 200.',
        params: programmeParams,
        querystring: z.object({
          mode: z.enum(FEED_MODES),
          fileName: z
            .string()
            .regex(FILE_NAME, 'Letters, digits, spaces and . _ ( ) -')
            .default('eligibility-feed.txt'),
        }),
        response: {
          200: EligibilityFeedSchema,
          202: EligibilityFeedSchema,
          ...commonErrors,
          412: z.any(),
          413: z.any(),
          415: z.any(),
        },
      },
    },
    async (request, reply) => {
      const { programmeId } = request.params;
      const { mode, fileName } = request.query;
      // Find the programme first: a caller who cannot see it learns nothing else about the endpoint.
      const programme = await withTx(deps.pool, request.ctx, (tx) =>
        findProgramme(tx, programmeId),
      );
      if (!request.headers['content-type']?.startsWith('application/octet-stream')) {
        throw new AppError(
          'validation_failed',
          'Send the feed file with content type application/octet-stream.',
        );
      }
      if (programme.status === 'closed')
        throw conflict('The programme is closed and accepts no feeds.');
      if (mode === 'live' && programme.status === 'draft') {
        throw preconditionFailed(
          'The programme is in draft. Send test feeds until one passes, then take it live.',
        );
      }

      const key = `card-feeds/${programme.id}/${randomUUID()}.txt`;
      let stored;
      try {
        stored = await deps.files.put(
          key,
          request.body as Readable,
          deps.config.CARD_FEED_MAX_BYTES,
        );
      } catch (err) {
        if (err instanceof FileTooLargeError) {
          throw new AppError(
            'payload_too_large',
            `Feed files are limited to ${deps.config.CARD_FEED_MAX_BYTES} bytes.`,
          );
        }
        throw err;
      }
      if (stored.sizeBytes === 0) {
        await deps.files.remove(key);
        throw new AppError('validation_failed', 'The file is empty.');
      }

      const { feed, created } = await withTx(deps.pool, request.ctx, async (tx) => {
        const inserted = await tx.query<FeedRow>(
          `INSERT INTO card.feeds (programme_id, account_id, mode, file_name, storage_key, sha256, size_bytes, received_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (programme_id, mode, sha256) DO NOTHING
           RETURNING ${FEED_COLUMNS}`,
          [
            programme.id,
            programme.account_id,
            mode,
            fileName,
            key,
            stored.sha256,
            stored.sizeBytes,
            request.ctx.principal.subject,
          ],
        );
        if (!inserted.rows[0]) {
          const existing = await tx.query<FeedRow>(
            `SELECT ${FEED_COLUMNS} FROM card.feeds WHERE programme_id = $1 AND mode = $2 AND sha256 = $3`,
            [programme.id, mode, stored.sha256],
          );
          return { feed: existing.rows[0]!, created: false };
        }
        const row = inserted.rows[0];
        await publishEvent(
          tx,
          request.ctx,
          EligibilityFeedReceived,
          { feedId: row.id, programmeId: programme.id, mode, sha256: stored.sha256 },
          { accountId: programme.account_id },
        );
        await writeAudit(tx, request.ctx, {
          action: 'eligibility_feed.received',
          resourceType: 'eligibility_feed',
          resourceId: row.id,
          accountId: programme.account_id,
          data: {
            programme: programme.code,
            mode,
            fileName,
            sha256: stored.sha256,
            sizeBytes: stored.sizeBytes,
          },
        });
        return { feed: row, created: true };
      });
      if (!created) {
        await deps.files.remove(key);
        reply.header('idempotent-replayed', 'true');
        return reply.code(200).send(toFeed(feed));
      }
      return reply
        .code(202)
        .header('location', `/v1/card-programmes/${programme.id}/feeds/${feed.id}`)
        .send(toFeed(feed));
    },
  );

  app.get(
    '/v1/card-programmes/:programmeId/feeds',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'List eligibility feeds for a programme, newest first',
        params: programmeParams,
        querystring: PageQuerySchema.extend({
          mode: z.enum(FEED_MODES).optional(),
          status: z.enum(FEED_STATUSES).optional(),
        }),
        response: { 200: pageOf(EligibilityFeedSchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, mode, status } = request.query;
      const after = decodeCursor(cursor, 2);
      const rows = await withTx(deps.pool, request.ctx, async (tx) => {
        await findProgramme(tx, request.params.programmeId);
        return (
          await tx.query<FeedRow>(
            `SELECT ${FEED_COLUMNS} FROM card.feeds
              WHERE programme_id = $1 AND ($2::text IS NULL OR mode = $2) AND ($3::text IS NULL OR status = $3)
                AND ($4::timestamptz IS NULL OR (received_at, id) < ($4::timestamptz, $5::uuid))
              ORDER BY received_at DESC, id DESC LIMIT $6`,
            [
              request.params.programmeId,
              mode ?? null,
              status ?? null,
              after?.[0] ?? null,
              after?.[1] ?? null,
              limit + 1,
            ],
          )
        ).rows;
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toFeed),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor([last.received_at.toISOString(), last.id])
            : null,
      };
    },
  );

  app.get(
    '/v1/card-programmes/:programmeId/feeds/:feedId',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Get an eligibility feed and its processing result',
        params: feedParams,
        response: { 200: EligibilityFeedSchema, ...commonErrors },
      },
    },
    async (request) =>
      toFeed(
        await withTx(deps.pool, request.ctx, (tx) =>
          findFeed(tx, request.params.programmeId, request.params.feedId),
        ),
      ),
  );

  app.get(
    '/v1/card-programmes/:programmeId/feeds/:feedId/rejections',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'List the records a feed rejected, by line number',
        params: feedParams,
        querystring: PageQuerySchema.extend({ code: z.string().max(40).optional() }),
        response: { 200: pageOf(FeedRejectionSchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, code } = request.query;
      const after = decodeCursor(cursor, 1);
      const rows = await withTx(deps.pool, request.ctx, async (tx) => {
        await findFeed(tx, request.params.programmeId, request.params.feedId);
        return (
          await tx.query<{
            line_no: number;
            account_ref: string | null;
            code: string;
            message: string;
          }>(
            `SELECT line_no, account_ref, code, message FROM card.feed_rejections
              WHERE feed_id = $1 AND ($2::text IS NULL OR code = $2) AND ($3::int IS NULL OR line_no > $3)
              ORDER BY line_no LIMIT $4`,
            [request.params.feedId, code ?? null, after?.[0] ?? null, limit + 1],
          )
        ).rows;
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map((r) => ({
          lineNumber: r.line_no,
          accountRef: r.account_ref,
          code: r.code,
          message: r.message,
        })),
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.line_no]) : null,
      };
    },
  );

  app.post(
    '/v1/card-programmes/:programmeId/feeds/:feedId/reject',
    {
      config: { tenancy: 'platform', permission: 'card:feeds' },
      schema: {
        tags: ['Card-linked cover'],
        summary:
          'Reject a held feed so the issuer can send a corrected file with the same sequence',
        params: feedParams,
        body: RejectFeedRequestSchema,
        response: { 200: EligibilityFeedSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const feed = await findFeed(tx, request.params.programmeId, request.params.feedId, true);
        if (feed.status !== 'held' && feed.status !== 'waiting') {
          throw conflict(`Only held or waiting feeds can be rejected; this one is ${feed.status}.`);
        }
        const { rows } = await tx.query<FeedRow>(
          `UPDATE card.feeds SET status = 'rejected', status_reason = $2, locked_until = NULL WHERE id = $1
           RETURNING ${FEED_COLUMNS}`,
          [feed.id, request.body.reason],
        );
        await tx.query(`DELETE FROM card.feed_records WHERE feed_id = $1`, [feed.id]);
        await writeAudit(tx, request.ctx, {
          action: 'eligibility_feed.rejected_by_user',
          resourceType: 'eligibility_feed',
          resourceId: feed.id,
          accountId: feed.account_id,
          reason: request.body.reason,
          data: { from: feed.status, sequence: feed.sequence },
        });
        return toFeed(rows[0]!);
      }),
  );

  // ---------------- Eligibility and cover ----------------

  app.post(
    '/v1/card-programmes/:programmeId/eligibility-checks',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Was an account eligible on a date, and which feed says so? (E21-F02-S02)',
        description:
          'The account reference is sent in the body, never in the URL. Every check is audited.',
        params: programmeParams,
        body: EligibilityCheckRequestSchema,
        response: { 200: EligibilityAnswerSchema, ...commonErrors },
      },
    },
    async (request) => {
      assertNotCardNumber(request.body.accountRef);
      return withTx(deps.pool, request.ctx, async (tx) => {
        const programme = await loadProgrammeById(tx, request.params.programmeId);
        const answer = await eligibilityOn(
          tx,
          programme,
          request.body.accountRef,
          request.body.date,
        );
        await writeAudit(tx, request.ctx, {
          action: 'eligibility.checked',
          resourceType: 'card_programme',
          resourceId: programme.id,
          accountId: programme.account_id,
          data: {
            accountRef: request.body.accountRef,
            date: request.body.date,
            eligible: answer.eligible,
          },
        });
        return answer;
      });
    },
  );

  app.post(
    '/v1/cover-verifications',
    {
      config: { tenancy: 'platform', permission: 'cover:verify' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Verify card-linked cover for a claim (E21-F03-S01)',
        description:
          'Answers whether the account was covered for a trip bought and lost on the given dates, with the ' +
          'feed versions behind the answer and the payment condition result. Every verification is audited.',
        body: CoverVerificationRequestSchema,
        response: { 200: CoverVerificationSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const result = await verifyCover(tx, request.body);
        await writeAudit(tx, request.ctx, {
          action: 'cover.verified',
          resourceType: 'card_programme',
          resourceId: result.programme.id,
          accountId: (
            await tx.query<{ account_id: string }>(
              `SELECT account_id FROM card.programmes WHERE id = $1`,
              [result.programme.id],
            )
          ).rows[0]!.account_id,
          data: {
            accountRef: request.body.accountRef,
            purchaseDate: request.body.purchaseDate,
            lossDate: request.body.lossDate,
            covered: result.covered,
            reasons: result.reasons,
            purchaseDateFeed: result.onPurchaseDate.supportedByFeed?.id ?? null,
            lossDateFeed: result.onLossDate.supportedByFeed?.id ?? null,
          },
        });
        return result;
      }),
  );
};
