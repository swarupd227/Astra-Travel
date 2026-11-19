import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AUDIT_ACTOR_TYPES,
  AuditEntrySchema,
  AuditVerificationSchema,
  pageOf,
  PageQuerySchema,
  type AuditEntry,
} from '@astra/contracts';
import { decodeCursor, encodeCursor, verifyAudit, withTx, writeAudit } from '@astra/platform';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';

interface AuditRow {
  seq: string;
  id: string;
  occurred_at: Date;
  actor_type: AuditEntry['actorType'];
  actor_id: string;
  actor_name: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  account_id: string | null;
  correlation_id: string;
  reason: string | null;
  data: Record<string, unknown>;
  sealed: boolean;
}

export const auditRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/audit',
    {
      config: { tenancy: 'platform', permission: 'audit:read' },
      schema: {
        tags: ['Audit'],
        summary: 'Search the audit trail, newest first',
        querystring: PageQuerySchema.extend({
          action: z.string().max(100).optional(),
          actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
          actorId: z.string().max(200).optional(),
          resourceType: z.string().max(100).optional(),
          resourceId: z.string().max(200).optional(),
          accountId: z.uuid().optional(),
          correlationId: z.string().max(128).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
        }),
        response: { 200: pageOf(AuditEntrySchema), ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const after = decodeCursor(q.cursor, 1);
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<AuditRow>(
          `SELECT a.seq, a.id, a.occurred_at, a.actor_type, a.actor_id, a.actor_name, a.action,
                  a.resource_type, a.resource_id, a.account_id, a.correlation_id, a.reason, a.data,
                  a.seq <= coalesce((SELECT max(to_seq) FROM audit.audit_seals), 0) AS sealed
             FROM audit.audit_log a
            WHERE ($1::text IS NULL OR a.action = $1)
              AND ($2::text IS NULL OR a.actor_type = $2)
              AND ($3::text IS NULL OR a.actor_id = $3)
              AND ($4::text IS NULL OR a.resource_type = $4)
              AND ($5::text IS NULL OR a.resource_id = $5)
              AND ($6::uuid IS NULL OR a.account_id = $6)
              AND ($7::text IS NULL OR a.correlation_id = $7)
              AND ($8::timestamptz IS NULL OR a.occurred_at >= $8)
              AND ($9::timestamptz IS NULL OR a.occurred_at < $9)
              AND ($10::bigint IS NULL OR a.seq < $10::bigint)
            ORDER BY a.seq DESC
            LIMIT $11`,
          [
            q.action ?? null,
            q.actorType ?? null,
            q.actorId ?? null,
            q.resourceType ?? null,
            q.resourceId ?? null,
            q.accountId ?? null,
            q.correlationId ?? null,
            q.from ?? null,
            q.to ?? null,
            after?.[0] ?? null,
            q.limit + 1,
          ],
        ),
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          seq: r.seq,
          id: r.id,
          occurredAt: r.occurred_at.toISOString(),
          actorType: r.actor_type,
          actorId: r.actor_id,
          actorName: r.actor_name,
          action: r.action,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          accountId: r.account_id,
          correlationId: r.correlation_id,
          reason: r.reason,
          data: r.data,
          sealed: r.sealed,
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor([last.seq]) : null,
      };
    },
  );

  app.post(
    '/v1/audit/verify',
    {
      config: { tenancy: 'platform', permission: 'audit:verify' },
      schema: {
        tags: ['Audit'],
        summary: 'Verify the integrity of the audit trail',
        description:
          'Recomputes the hash of every audit record and every seal in the hash chain. The verification itself is recorded in the audit trail.',
        response: { 200: AuditVerificationSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const result = await verifyAudit(tx);
        await writeAudit(tx, request.ctx, {
          action: 'audit.verified',
          resourceType: 'audit_trail',
          data: {
            ok: result.ok,
            rowsChecked: result.rowsChecked,
            sealsChecked: result.sealsChecked,
            firstMismatch: result.firstMismatch,
          },
        });
        return result;
      }),
  );
};
