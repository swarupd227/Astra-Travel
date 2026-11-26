import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  CreateTemplateRequestSchema,
  DocumentTemplateReleased,
  FailedDeliverySchema,
  GuideRequestSchema,
  IssueNoticeRequestSchema,
  IssuedDocumentDetailSchema,
  IssuedDocumentSchema,
  ReleaseTemplateRequestSchema,
  TemplateSchema,
  TemplateSummarySchema,
  type CatalogueDocument,
  type DocumentKind,
  type IssuedDocument,
  type PlanDocument,
  type PolicySnapshot,
} from '@astra/contracts';
import { ARRANGEMENT_NAMES, BUILDER_VERSION, guideToBenefits } from '@astra/documents';
import { AppError, conflict, forbidden, notFound, publishEvent, withTx, writeAudit, type Tx } from '@astra/platform';
import { benefitLimits } from '@astra/policies';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';
import { assembleFor, holdsFor, templateView, type TemplateRow } from '../documents/template';
import { issueNotice, issuePolicyDocuments, storeDocument } from '../documents/issue';

/** Document templates, issued documents, delivery and the Guide to Benefits (E09, E21-F05). Design: docs/adr/0011. */

const idParams = z.object({ id: z.uuid() });

const TEMPLATE_COLUMNS = `t.*`;

async function findTemplate(tx: Tx, id: string, lock = false): Promise<TemplateRow> {
  const r = (await tx.query<TemplateRow>(`SELECT ${TEMPLATE_COLUMNS} FROM documents.templates t WHERE t.id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!r) throw notFound('The document template');
  return r;
}

interface DocRow {
  id: string;
  kind: DocumentKind;
  title: string;
  status: 'issued' | 'failed';
  failure: string | null;
  account_id: string;
  policy_id: string | null;
  policy_number: string | null;
  programme_id: string | null;
  template_id: string | null;
  source: string | null;
  version: number | null;
  sha256: string | null;
  size_bytes: string | null;
  issued_at: Date;
  text?: string | null;
  deliveries: { id: string; channel: 'email' | 'account'; recipient: string | null; status: 'queued' | 'sent' | 'available' | 'failed'; attempts: number; last_error: string | null; next_attempt_at: string | null; delivered_at: string | null }[];
}

const DOC_SELECT = `SELECT d.id, d.kind, d.title, d.status, d.failure, d.account_id, d.policy_id, p.number AS policy_number, d.programme_id, d.template_id, d.source, d.version,
       d.sha256, d.size_bytes::text, d.issued_at,
       coalesce((SELECT json_agg(json_build_object('id', x.id, 'channel', x.channel, 'recipient', x.recipient, 'status', x.status, 'attempts', x.attempts, 'last_error', x.last_error,
                                                     'next_attempt_at', x.next_attempt_at, 'delivered_at', x.delivered_at) ORDER BY x.channel) FROM documents.deliveries x WHERE x.document_id = d.id), '[]') AS deliveries`;
const DOC_FROM = `FROM documents.documents d LEFT JOIN policies.policies p ON p.id = d.policy_id`;

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
const toDoc = (r: DocRow): IssuedDocument => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  status: r.status,
  failure: r.failure,
  accountId: r.account_id,
  policyId: r.policy_id,
  policyNumber: r.policy_number,
  programmeId: r.programme_id,
  templateId: r.template_id,
  source: r.source,
  version: r.version,
  sha256: r.sha256,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  issuedAt: r.issued_at.toISOString(),
  deliveries: r.deliveries.map((d) => ({ id: d.id, channel: d.channel, recipient: d.recipient, status: d.status, attempts: d.attempts, lastError: d.last_error, nextAttemptAt: iso(d.next_attempt_at), deliveredAt: iso(d.delivered_at) })),
});

async function documentById(tx: Tx, id: string): Promise<DocRow> {
  const r = (await tx.query<DocRow>(`${DOC_SELECT} ${DOC_FROM} WHERE d.id = $1`, [id])).rows[0];
  if (!r) throw notFound('The document');
  return r;
}

/** Issued documents matching a condition on `d`, oldest first. */
export async function issuedDocuments(tx: Tx, where: string, params: unknown[]): Promise<IssuedDocument[]> {
  return (await tx.query<DocRow>(`${DOC_SELECT} ${DOC_FROM} WHERE ${where} ORDER BY d.issued_at, d.kind`, params)).rows.map(toDoc);
}

export const documentRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // ---------------- Templates ----------------

  app.post(
    '/v1/document-templates',
    {
      config: { tenancy: 'platform', permission: 'documents:manage' },
      schema: {
        tags: ['Documents'],
        summary: 'Assemble a plan version’s schedule or policy from the filed form (E09-F01-S01)',
        description:
          'Fills the filed form’s bracketed options and values with the plan’s values in the filed format (words and figures for periods and percentages, limit basis as chosen), removes optional benefits the plan does not offer, and lists every problem. A template with problems can be seen but not released. Creating a new one supersedes an unreleased earlier one.',
        body: CreateTemplateRequestSchema,
        response: { 201: TemplateSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const principal = request.ctx.principal;
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const built = await assembleFor(tx, request.body.planVersionId, request.body.kind);
        await tx.query(`UPDATE documents.templates SET status = 'superseded' WHERE plan_version_id = $1 AND kind = $2 AND status = 'draft'`, [request.body.planVersionId, request.body.kind]);
        const version = (await tx.query<{ v: number }>(`SELECT coalesce(max(version), 0) + 1 AS v FROM documents.templates WHERE plan_version_id = $1 AND kind = $2`, [request.body.planVersionId, request.body.kind])).rows[0]!.v;
        const row = (
          await tx.query<TemplateRow>(
            `INSERT INTO documents.templates (plan_version_id, kind, version, edition_id, map_id, text, problems, inserted, removed, checks, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [request.body.planVersionId, request.body.kind, version, built.edition.id, built.map.id, built.text, JSON.stringify(built.problems), built.inserted, built.removed, JSON.stringify(built.checks), principal.subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, { action: 'document_template.created', resourceType: 'document_template', resourceId: row.id, data: { plan: built.planVersion.planCode, planVersion: built.planVersion.version, kind: request.body.kind, version, problems: built.problems.length } });
        return templateView(tx, row);
      });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/v1/document-templates',
    {
      config: { tenancy: 'platform', permission: 'documents:read' },
      schema: {
        tags: ['Documents'],
        summary: 'Document templates, newest first',
        querystring: z.object({ planVersionId: z.uuid().optional(), status: z.enum(['draft', 'released', 'superseded']).optional() }),
        response: { 200: z.object({ items: z.array(TemplateSummarySchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const { rows } = await tx.query<TemplateRow>(
          `SELECT ${TEMPLATE_COLUMNS} FROM documents.templates t WHERE ($1::uuid IS NULL OR t.plan_version_id = $1) AND ($2::text IS NULL OR t.status = $2) ORDER BY t.created_at DESC LIMIT 200`,
          [request.query.planVersionId ?? null, request.query.status ?? null],
        );
        const items: z.infer<typeof TemplateSummarySchema>[] = [];
        for (const r of rows) {
          const { text: _t, problems: _p, removed: _r, checks: _c, ...rest } = await templateView(tx, r);
          items.push(rest);
        }
        return { items };
      }),
  );

  app.get(
    '/v1/document-templates/:id',
    {
      config: { tenancy: 'platform', permission: 'documents:read' },
      schema: { tags: ['Documents'], summary: 'A template with its assembled text, problems and checks', params: idParams, response: { 200: TemplateSchema, ...commonErrors } },
    },
    async (request) => withTx(deps.pool, request.ctx, async (tx) => templateView(tx, await findTemplate(tx, request.params.id))),
  );

  app.post(
    '/v1/document-templates/:id/release',
    {
      config: { tenancy: 'platform', permission: 'documents:release' },
      schema: {
        tags: ['Documents'],
        summary: 'Release a template so policies are issued with it (E09-F02-S01)',
        description:
          'The assembly is rerun and must give the same text; every check must pass; no finding of the Document Quality agent may be open or accepted; and the person releasing must not be the one who made the template. Releasing replaces the plan version’s earlier released template.',
        params: idParams,
        body: ReleaseTemplateRequestSchema,
        response: { 200: TemplateSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const principal = request.ctx.principal;
        const cur = await findTemplate(tx, request.params.id, true);
        if (cur.status !== 'draft') throw conflict(`This template is ${cur.status}.`);
        if (cur.created_by === principal.subject) throw forbidden('A template is released by someone other than the person who made it.');
        const built = await assembleFor(tx, cur.plan_version_id, cur.kind);
        const failed = [...built.checks, ...cur.checks].filter((c) => !c.passed);
        if (built.text !== cur.text) throw conflict('The plan, its form or a reference list has changed since this template was made. Make a new template.');
        if (failed.length || built.problems.length) throw new AppError('precondition_failed', `This template cannot be released: ${failed.map((c) => c.detail).join(' ') || built.problems[0]!.message}`, built.problems.slice(0, 20).map((p) => ({ code: 'template_problem', field: p.variable ?? 'text', message: p.message })));
        const holds = await holdsFor(tx, cur.id);
        if (holds.open || holds.accepted) {
          throw new AppError('precondition_failed', holds.open ? `The Document Quality agent has ${holds.open} open finding${holds.open === 1 ? '' : 's'} on this template. A person must review them before release.` : `${holds.accepted} accepted finding${holds.accepted === 1 ? '' : 's'} of the Document Quality agent show a defect. Correct the plan or form and make a new template.`, [{ code: 'quality_hold', field: 'template', message: 'Held by the Document Quality agent' }]);
        }
        await tx.query(`UPDATE documents.templates SET status = 'superseded' WHERE plan_version_id = $1 AND kind = $2 AND status = 'released'`, [cur.plan_version_id, cur.kind]);
        const row = (await tx.query<TemplateRow>(`UPDATE documents.templates SET status = 'released', released_by = $2, released_at = now(), release_note = $3 WHERE id = $1 RETURNING *`, [cur.id, principal.subject, request.body.note ?? null])).rows[0]!;
        await publishEvent(tx, request.ctx, DocumentTemplateReleased, { templateId: cur.id, planCode: built.planVersion.planCode, kind: cur.kind, version: cur.version }, { accountId: null });
        await writeAudit(tx, request.ctx, { action: 'document_template.released', resourceType: 'document_template', resourceId: cur.id, reason: request.body.note, data: { plan: built.planVersion.planCode, planVersion: built.planVersion.version, kind: cur.kind, version: cur.version } });
        return templateView(tx, row);
      }),
  );

  // ---------------- Issued documents ----------------

  app.get(
    '/v1/policies/:policyId/documents',
    {
      config: { tenancy: 'account', permission: 'documents:read' },
      schema: { tags: ['Documents'], summary: 'The documents issued for a policy, with how each was delivered', params: z.object({ policyId: z.uuid() }), response: { 200: z.object({ items: z.array(IssuedDocumentSchema) }), ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const p = (await tx.query(`SELECT 1 FROM policies.policies WHERE id = $1`, [request.params.policyId])).rowCount;
        if (!p) throw notFound('The policy');
        const { rows } = await tx.query<DocRow>(`${DOC_SELECT} ${DOC_FROM} WHERE d.policy_id = $1 ORDER BY d.issued_at, d.kind`, [request.params.policyId]);
        return { items: rows.map(toDoc) };
      }),
  );

  app.post(
    '/v1/policies/:policyId/documents/issue',
    {
      config: { tenancy: 'account', permission: 'documents:manage' },
      schema: {
        tags: ['Documents'],
        summary: 'Issue the purchase confirmation, schedule and policy that are missing or failed',
        description: 'For a policy bound before its plan’s templates were released, or whose document could not be produced. Documents already issued are left as they are.',
        params: z.object({ policyId: z.uuid() }),
        response: { 200: z.object({ items: z.array(IssuedDocumentSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const pol = (await tx.query<{ id: string; account_id: string; plan_version_id: string }>(`SELECT id, account_id, plan_version_id FROM policies.policies WHERE id = $1`, [request.params.policyId])).rows[0];
        if (!pol) throw notFound('The policy');
        const bound = (await tx.query<{ data: PolicySnapshot }>(`SELECT data FROM policies.policy_events WHERE policy_id = $1 AND type = 'bound'`, [pol.id])).rows[0]!;
        await issuePolicyDocuments(tx, deps.files, request.ctx, { policyId: pol.id, accountId: pol.account_id, snapshot: bound.data, planVersionId: pol.plan_version_id });
        const { rows } = await tx.query<DocRow>(`${DOC_SELECT} ${DOC_FROM} WHERE d.policy_id = $1 ORDER BY d.issued_at, d.kind`, [pol.id]);
        return { items: rows.map(toDoc) };
      }),
  );

  app.post(
    '/v1/policies/:policyId/notices',
    {
      config: { tenancy: 'account', permission: 'documents:manage' },
      schema: {
        tags: ['Documents'],
        summary: 'Issue the notice for a change or cancellation (E09-F01-S03)',
        description: 'A change notice states what changed between the policy before and after the event; a cancellation or expiry notice states when cover ended. One notice per event.',
        params: z.object({ policyId: z.uuid() }),
        body: IssueNoticeRequestSchema,
        response: { 201: IssuedDocumentSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const ref = await issueNotice(tx, deps.files, request.ctx, request.params.policyId, request.body.eventSeq);
        return toDoc(await documentById(tx, ref.id));
      });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/v1/documents/:id',
    {
      config: { tenancy: 'account', permission: 'documents:read' },
      schema: { tags: ['Documents'], summary: 'An issued document with its text', params: idParams, response: { 200: IssuedDocumentDetailSchema, ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const d = await documentById(tx, request.params.id);
        const text = (await tx.query<{ text: string | null }>(`SELECT text FROM documents.documents WHERE id = $1`, [d.id])).rows[0]!.text;
        return { ...toDoc(d), text };
      }),
  );

  app.get(
    '/v1/documents/:id/file',
    {
      config: { tenancy: 'account', permission: 'documents:read' },
      schema: { tags: ['Documents'], summary: 'The document as a PDF', description: 'Every download is audited.', params: idParams, produces: ['application/pdf'], response: { ...commonErrors } },
    },
    async (request, reply) => {
      const d = await withTx(deps.pool, request.ctx, async (tx) => {
        const r = (await tx.query<{ id: string; kind: string; file_key: string | null; account_id: string; number: string | null; sha256: string | null }>(
          `SELECT d.id, d.kind, d.file_key, d.account_id, p.number, d.sha256 FROM documents.documents d LEFT JOIN policies.policies p ON p.id = d.policy_id WHERE d.id = $1`,
          [request.params.id],
        )).rows[0];
        if (!r) throw notFound('The document');
        if (!r.file_key) throw conflict('This document was not produced, so there is no file.');
        await writeAudit(tx, request.ctx, { action: 'document.downloaded', resourceType: 'document', resourceId: r.id, accountId: r.account_id, data: { kind: r.kind } });
        return r;
      });
      const name = `${d.number ?? d.kind}-${d.kind}`.replace(/[^A-Za-z0-9._-]/g, '_');
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `inline; filename="${name}.pdf"`)
        .header('x-content-sha256', d.sha256 ?? '')
        .header('cache-control', 'private, no-store')
        .send(deps.files.read(d.file_key!) as never);
    },
  );

  // ---------------- Delivery ----------------

  app.get(
    '/v1/document-failures',
    {
      config: { tenancy: 'account', permission: 'documents:read' },
      schema: {
        tags: ['Documents'],
        summary: 'Documents that could not be produced and deliveries that failed (E09-F03-S01)',
        response: { 200: z.object({ documents: z.array(IssuedDocumentSchema), deliveries: z.array(FailedDeliverySchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const docs = (await tx.query<DocRow>(`${DOC_SELECT} ${DOC_FROM} WHERE d.status = 'failed' ORDER BY d.issued_at DESC LIMIT 200`)).rows.map(toDoc);
        const del = (
          await tx.query<{ id: string; document_id: string; kind: DocumentKind; number: string | null; account_id: string; channel: 'email' | 'account'; recipient: string | null; attempts: number; last_error: string | null; updated_at: Date }>(
            `SELECT x.id, x.document_id, d.kind, p.number, x.account_id, x.channel, x.recipient, x.attempts, x.last_error, x.updated_at
               FROM documents.deliveries x JOIN documents.documents d ON d.id = x.document_id LEFT JOIN policies.policies p ON p.id = d.policy_id
              WHERE x.status = 'failed' ORDER BY x.updated_at DESC LIMIT 200`,
          )
        ).rows;
        return {
          documents: docs,
          deliveries: del.map((x) => ({ id: x.id, documentId: x.document_id, documentKind: x.kind, policyNumber: x.number, accountId: x.account_id, channel: x.channel, recipient: x.recipient, status: 'failed' as const, attempts: x.attempts, lastError: x.last_error, nextAttemptAt: null, deliveredAt: null })),
        };
      }),
  );

  app.post(
    '/v1/document-deliveries/:id/retry',
    {
      config: { tenancy: 'account', permission: 'documents:manage' },
      schema: { tags: ['Documents'], summary: 'Queue a failed delivery to be sent again', params: idParams, response: { 200: IssuedDocumentSchema, ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const x = (await tx.query<{ id: string; status: string; document_id: string; account_id: string }>(`SELECT id, status, document_id, account_id FROM documents.deliveries WHERE id = $1 FOR UPDATE`, [request.params.id])).rows[0];
        if (!x) throw notFound('The delivery');
        if (x.status !== 'failed') throw conflict(`This delivery is ${x.status}; only a failed delivery can be retried.`);
        await tx.query(`UPDATE documents.deliveries SET status = 'queued', attempts = 0, next_attempt_at = now(), updated_at = now() WHERE id = $1`, [x.id]);
        await writeAudit(tx, request.ctx, { action: 'document_delivery.retried', resourceType: 'document_delivery', resourceId: x.id, accountId: x.account_id, data: { documentId: x.document_id } });
        return toDoc(await documentById(tx, x.document_id));
      }),
  );

  // ---------------- Guide to Benefits (E21-F05-S01) ----------------

  app.post(
    '/v1/card-programmes/:programmeId/guides',
    {
      config: { tenancy: 'account', permission: 'documents:manage' },
      schema: {
        tags: ['Documents'],
        summary: 'Produce the next version of a card programme’s Guide to Benefits',
        description: 'Built from the programme, its master policy and the benefits and limits of the plan version published for the plan code on the date. Each guide is a new version; earlier ones stay as issued.',
        params: z.object({ programmeId: z.uuid() }),
        body: GuideRequestSchema,
        response: { 201: IssuedDocumentSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const prog = (
          await tx.query<{ id: string; account_id: string; code: string; name: string; card_product: string; states: string[]; master_policy_id: string }>(
            `SELECT id, account_id, code, name, card_product, states, master_policy_id FROM card.programmes WHERE id = $1 FOR UPDATE`,
            [request.params.programmeId],
          )
        ).rows[0];
        if (!prog) throw notFound('The card programme');
        const mp = (await tx.query<{ policy_number: string; underwriter: 'VSC' | 'ABIC'; effective_from: string; effective_to: string | null }>(`SELECT policy_number, underwriter, effective_from::text, effective_to::text FROM card.master_policies WHERE id = $1`, [prog.master_policy_id])).rows[0]!;
        const date = request.body.asOf ?? new Date().toISOString().slice(0, 10);
        const pv = (
          await tx.query<{ version: number; document: PlanDocument; catalogue_id: string; name: string }>(
            `SELECT v.version, v.document, v.catalogue_id, p.name FROM plans.plan_versions v JOIN plans.plans p ON p.id = v.plan_id
              WHERE p.code = $1 AND v.status = 'published' AND v.effective_from <= $2::date AND (v.effective_to IS NULL OR v.effective_to > $2::date)`,
            [request.body.planCode, date],
          )
        ).rows[0];
        if (!pv) throw new AppError('validation_failed', `No version of plan ${request.body.planCode} is published on ${date}.`, [{ code: 'no_plan_version', field: 'planCode', message: 'No published version' }]);
        const cat = (await tx.query<{ document: CatalogueDocument }>(`SELECT document FROM studio.benefit_catalogues WHERE id = $1`, [pv.catalogue_id])).rows[0]!.document;
        const version = (await tx.query<{ v: number }>(`SELECT coalesce(max(version), 0) + 1 AS v FROM documents.documents WHERE programme_id = $1 AND kind = 'guide_to_benefits'`, [prog.id])).rows[0]!.v;
        const benefits = pv.document.benefits.map((b) => {
          const c = cat.benefits.find((x) => x.code === b.code);
          return { name: c?.name ?? b.code, limit: benefitLimits(pv.document, cat, b.code), underwriter: b.underwriter ? ARRANGEMENT_NAMES[b.underwriter] : null };
        });
        const model = guideToBenefits({
          programme: { code: prog.code, name: prog.name, cardProduct: prog.card_product, states: prog.states },
          masterPolicy: { policyNumber: mp.policy_number, underwriter: mp.underwriter, effectiveFrom: mp.effective_from, effectiveTo: mp.effective_to },
          plan: { code: request.body.planCode, name: pv.name, version: pv.version },
          benefits,
          version,
        });
        const id = await storeDocument(tx, deps.files, {
          accountId: prog.account_id,
          kind: 'guide_to_benefits',
          title: `Guide to Benefits, ${prog.name}`,
          policyId: null,
          programmeId: prog.id,
          templateId: null,
          eventSeq: null,
          source: `plan ${request.body.planCode} v${pv.version} · builder ${BUILDER_VERSION}`,
          version,
          model,
          email: null,
          actor: request.ctx.principal.subject,
        });
        await writeAudit(tx, request.ctx, { action: 'guide.issued', resourceType: 'card_programme', resourceId: prog.id, accountId: prog.account_id, data: { documentId: id, version, plan: request.body.planCode, planVersion: pv.version } });
        return toDoc(await documentById(tx, id));
      });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/v1/card-programmes/:programmeId/guides',
    {
      config: { tenancy: 'account', permission: 'documents:read' },
      schema: { tags: ['Documents'], summary: 'The guides issued for a card programme, newest version first', params: z.object({ programmeId: z.uuid() }), response: { 200: z.object({ items: z.array(IssuedDocumentSchema) }), ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const ok = (await tx.query(`SELECT 1 FROM card.programmes WHERE id = $1`, [request.params.programmeId])).rowCount;
        if (!ok) throw notFound('The card programme');
        const { rows } = await tx.query<DocRow>(`${DOC_SELECT} ${DOC_FROM} WHERE d.programme_id = $1 AND d.kind = 'guide_to_benefits' ORDER BY d.version DESC`, [request.params.programmeId]);
        return { items: rows.map(toDoc) };
      }),
  );
};
