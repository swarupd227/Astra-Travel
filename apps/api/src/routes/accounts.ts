import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  ACCOUNT_KINDS,
  ACCOUNT_STATUS_TRANSITIONS,
  ACCOUNT_STATUSES,
  AccountRegistered,
  AccountSchema,
  AccountStatusChanged,
  ChangeAccountStatusRequestSchema,
  CreateAccountRequestSchema,
  pageOf,
  PageQuerySchema,
  type Account,
  type AccountStatus,
} from '@astra/contracts';
import {
  AppError,
  decodeCursor,
  encodeCursor,
  isUniqueViolation,
  notFound,
  publishEvent,
  withIdempotency,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import type { AppDeps } from '../app';
import { commonErrors, escapeLike, idempotencyHeaders, idempotencyKey } from './shared';

interface AccountRow {
  id: string;
  code: string;
  name: string;
  kind: Account['kind'];
  status: Account['status'];
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, code, name, kind, status, created_at, updated_at';

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function findAccount(tx: Tx, id: string, lock = false): Promise<AccountRow | null> {
  const { rows } = await tx.query<AccountRow>(
    `SELECT ${COLUMNS} FROM platform.accounts WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

export const accountRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/accounts',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Accounts'],
        summary: 'List the accounts you can see',
        querystring: PageQuerySchema.extend({
          status: z.enum(ACCOUNT_STATUSES).optional(),
          kind: z.enum(ACCOUNT_KINDS).optional(),
          q: z.string().trim().min(1).max(100).optional(),
        }),
        response: { 200: pageOf(AccountSchema), ...commonErrors },
      },
    },
    async (request) => {
      const { limit, cursor, status, kind, q } = request.query;
      const after = decodeCursor(cursor, 2);
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<AccountRow>(
          `SELECT ${COLUMNS} FROM platform.accounts
            WHERE ($1::text IS NULL OR status = $1)
              AND ($2::text IS NULL OR kind = $2)
              AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR code ILIKE '%' || $3 || '%')
              AND ($4::text IS NULL OR (name, id) > ($4::text, $5::uuid))
            ORDER BY name, id
            LIMIT $6`,
          [
            status ?? null,
            kind ?? null,
            q ? escapeLike(q) : null,
            after?.[0] ?? null,
            after?.[1] ?? null,
            limit + 1,
          ],
        ),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toAccount),
        nextCursor: rows.length > limit && last ? encodeCursor([last.name, last.id]) : null,
      };
    },
  );

  app.post(
    '/v1/accounts',
    {
      config: { tenancy: 'platform', permission: 'accounts:manage' },
      schema: {
        tags: ['Accounts'],
        summary: 'Register an account (travel seller, card issuer or bank)',
        headers: idempotencyHeaders,
        body: CreateAccountRequestSchema,
        response: { 201: AccountSchema, ...commonErrors },
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
            path: '/v1/accounts',
            body,
            accountId: null,
          },
          async () => {
            let row: AccountRow;
            try {
              const res = await tx.query<AccountRow>(
                `INSERT INTO platform.accounts (code, name, kind, created_by)
                 VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
                [body.code, body.name, body.kind, request.ctx.principal.subject],
              );
              row = res.rows[0]!;
            } catch (err) {
              if (isUniqueViolation(err)) {
                throw new AppError(
                  'conflict',
                  `An account with code ${body.code} already exists.`,
                  [{ code: 'duplicate', message: 'This code is already used.', field: 'code' }],
                );
              }
              throw err;
            }
            await writeAudit(tx, request.ctx, {
              action: 'account.registered',
              resourceType: 'account',
              resourceId: row.id,
              accountId: row.id,
              data: { code: row.code, name: row.name, kind: row.kind },
            });
            await publishEvent(
              tx,
              request.ctx,
              AccountRegistered,
              { accountId: row.id, code: row.code, name: row.name, kind: row.kind },
              { accountId: row.id },
            );
            return { status: 201, body: toAccount(row) };
          },
        ),
      );
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(201).header('location', `/v1/accounts/${result.body.id}`).send(result.body);
    },
  );

  app.get(
    '/v1/accounts/:accountId',
    {
      config: { tenancy: 'account', permission: 'accounts:read' },
      schema: {
        tags: ['Accounts'],
        summary: 'Get an account',
        params: z.object({ accountId: z.uuid() }),
        response: { 200: AccountSchema, ...commonErrors },
      },
    },
    async (request) => {
      const row = await withTx(deps.pool, request.ctx, (tx) =>
        findAccount(tx, request.params.accountId),
      );
      if (!row) throw notFound('Account');
      return toAccount(row);
    },
  );

  app.post(
    '/v1/accounts/:accountId/status',
    {
      config: { tenancy: 'platform', permission: 'accounts:manage' },
      schema: {
        tags: ['Accounts'],
        summary: 'Change an account status (suspend, reactivate or close)',
        params: z.object({ accountId: z.uuid() }),
        body: ChangeAccountStatusRequestSchema,
        response: { 200: AccountSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { accountId } = request.params;
      const { status: to, reason } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const current = await findAccount(tx, accountId, true);
        if (!current) throw notFound('Account');
        const from = current.status as AccountStatus;
        if (from === to) return toAccount(current);
        if (!ACCOUNT_STATUS_TRANSITIONS[from].includes(to)) {
          throw new AppError(
            'conflict',
            from === 'onboarding' && to === 'active'
              ? 'An account goes live through the onboarding checklist, not a direct status change.'
              : `An account cannot move from ${from} to ${to}.`,
          );
        }
        const { rows } = await tx.query<AccountRow>(
          `UPDATE platform.accounts SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
          [accountId, to],
        );
        await writeAudit(tx, request.ctx, {
          action: 'account.status_changed',
          resourceType: 'account',
          resourceId: accountId,
          accountId,
          reason,
          data: { from, to },
        });
        await publishEvent(
          tx,
          request.ctx,
          AccountStatusChanged,
          { accountId, from, to, reason },
          { accountId },
        );
        return toAccount(rows[0]!);
      });
    },
  );
};
