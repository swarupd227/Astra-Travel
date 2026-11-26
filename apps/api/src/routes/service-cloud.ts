import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CustomerViewRequestSchema, CustomerViewSchema, ResendDocumentsRequestSchema, ResendDocumentsResultSchema } from '@astra/contracts';
import { conflict, hasPermission, notFound, withTx, writeAudit } from '@astra/platform';
import type { AppDeps } from '../app';
import { externalCaseOf } from '../http/service-cloud';
import { issuedDocuments } from './documents';
import { policyView } from './policies';
import { commonErrors } from './shared';

/** The customer view and document resend for Salesforce Service Cloud (E14-F02). Design: docs/adr/0019. */

const LIMIT = 10;

export const serviceCloudRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.post(
    '/v1/service/customer-view',
    {
      config: { tenancy: 'account', permission: 'policies:read' },
      schema: {
        tags: ['Service Cloud'],
        summary: 'A customer’s cover, documents and history, found by policy number, name and date of birth, or cardholder reference (E14-F02-S01)',
        description:
          'The caller signs in as the representative, so their role and account scope decide what is returned: certificates need card:read and documents documents:read. At most the ten most recent policies. Every lookup is audited with the kind of detail used and what was returned, not the detail itself.',
        body: CustomerViewRequestSchema,
        response: { 200: CustomerViewSchema, ...commonErrors },
      },
    },
    async (request) => {
      const q = request.body;
      const principal = request.ctx.principal;
      const externalCase = externalCaseOf(request);
      const withDocuments = hasPermission(principal, 'documents:read');
      return withTx(deps.pool, request.ctx, async (tx) => {
        let ids: string[] = [];
        if ('policyNumber' in q) {
          ids = (await tx.query<{ id: string }>(`SELECT id FROM policies.policies WHERE upper(number) = upper($1)`, [q.policyNumber])).rows.map((r) => r.id);
        } else if ('lastName' in q) {
          ids = (
            await tx.query<{ id: string }>(
              `SELECT p.id FROM policies.policies p
                WHERE EXISTS (SELECT 1 FROM policies.policy_travellers t WHERE t.policy_id = p.id AND lower(t.last_name) = lower($1) AND t.date_of_birth = $2::date)
                ORDER BY p.created_at DESC LIMIT $3`,
              [q.lastName, q.dateOfBirth, LIMIT + 1],
            )
          ).rows.map((r) => r.id);
        }
        const policies = [];
        for (const id of ids.slice(0, LIMIT)) {
          policies.push({ policy: await policyView(tx, id), documents: withDocuments ? await issuedDocuments(tx, 'd.policy_id = $1', [id]) : [] });
        }
        const certificates = [];
        if ('cardholderRef' in q && hasPermission(principal, 'card:read')) {
          const rows = (
            await tx.query<{ certificate_number: string; code: string; name: string; account_id: string; account_ref: string; programme_id: string; eligibility: { productCode: string; from: string; to: string | null }[] }>(
              `SELECT c.certificate_number, pr.code, pr.name, c.account_id, c.account_ref, c.programme_id,
                      (SELECT coalesce(jsonb_agg(jsonb_build_object('productCode', ep.product_code, 'from', ep.valid_from, 'to', ep.valid_to) ORDER BY ep.valid_from, ep.id), '[]')
                         FROM card.eligibility_periods ep WHERE ep.programme_id = c.programme_id AND ep.account_ref = c.account_ref) AS eligibility
                 FROM card.certificates c JOIN card.programmes pr ON pr.id = c.programme_id
                WHERE c.account_ref = $1 ORDER BY c.issued_at DESC LIMIT $2`,
              [q.cardholderRef, LIMIT],
            )
          ).rows;
          for (const c of rows) {
            certificates.push({
              certificateNumber: c.certificate_number,
              programmeCode: c.code,
              programmeName: c.name,
              accountId: c.account_id,
              cardholderRef: c.account_ref,
              eligibility: c.eligibility,
              documents: withDocuments ? await issuedDocuments(tx, 'd.programme_id = $1', [c.programme_id]) : [],
            });
          }
        }
        await writeAudit(tx, request.ctx, {
          action: 'customer_view.read',
          resourceType: 'customer_view',
          resourceId: policies[0]?.policy.id ?? certificates[0]?.certificateNumber ?? 'none',
          data: { by: 'policyNumber' in q ? 'policy_number' : 'lastName' in q ? 'name_and_date_of_birth' : 'cardholder_reference', policies: policies.map((p) => p.policy.number), certificates: certificates.map((c) => c.certificateNumber), ...(externalCase ? { externalCase } : {}) },
        });
        return { policies, certificates, truncated: ids.length > LIMIT };
      });
    },
  );

  app.post(
    '/v1/policies/:policyId/documents/resend',
    {
      config: { tenancy: 'account', permission: 'servicing:execute' },
      schema: {
        tags: ['Service Cloud'],
        summary: 'Send a policy’s documents again to the address they were sent to (E14-F02-S02)',
        description: 'Queues the email deliveries on record again; the address cannot be changed here (correct the policy first). Earlier attempts stay on record.',
        params: z.object({ policyId: z.uuid() }),
        body: ResendDocumentsRequestSchema,
        response: { 202: ResendDocumentsResultSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const externalCase = externalCaseOf(request);
      const { documentIds, reason } = request.body;
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const p = (await tx.query<{ account_id: string; number: string }>(`SELECT account_id, number FROM policies.policies WHERE id = $1`, [request.params.policyId])).rows[0];
        if (!p) throw notFound('The policy');
        const rows = (
          await tx.query<{ id: string; status: string; document_id: string; title: string }>(
            `SELECT x.id, x.status, x.document_id, d.title FROM documents.deliveries x JOIN documents.documents d ON d.id = x.document_id
              WHERE d.policy_id = $1 AND x.channel = 'email' AND ($2::uuid[] IS NULL OR d.id = ANY ($2)) ORDER BY d.issued_at, d.kind FOR UPDATE OF x`,
            [request.params.policyId, documentIds ?? null],
          )
        ).rows;
        const missing = (documentIds ?? []).filter((id) => !rows.some((r) => r.document_id === id));
        if (missing.length) throw notFound('A document emailed for this policy');
        if (rows.length === 0) throw conflict('None of this policy’s documents has been emailed, so there is nothing to send again.');
        const again = rows.filter((r) => r.status !== 'queued');
        if (again.length) await tx.query(`UPDATE documents.deliveries SET status = 'queued', attempts = 0, next_attempt_at = now(), updated_at = now(), receipt = NULL, receipt_at = NULL, receipt_detail = NULL WHERE id = ANY ($1::uuid[])`, [again.map((r) => r.id)]);
        await writeAudit(tx, request.ctx, { action: 'documents.resent', resourceType: 'policy', resourceId: request.params.policyId, accountId: p.account_id, reason, data: { number: p.number, documents: again.map((r) => r.document_id), ...(externalCase ? { externalCase } : {}) } });
        return { queued: again.map((r) => ({ documentId: r.document_id, title: r.title })), alreadyQueued: rows.length - again.length };
      });
      return reply.code(202).send(out);
    },
  );
};
