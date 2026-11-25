import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AgentProposalRaised,
  AgentProposalResolved,
  ProposalSchema,
  REFDATA_DATASET_CODES,
  ResolveProposalSchema,
  SubmitProposalSchema,
  type ManualDocument,
  type Proposal,
  type ProposalKind,
  type SubmitProposal,
} from '@astra/contracts';
import { AppError, conflict, forbidden, notFound, publishEvent, withTx, writeAudit, hasPermission, type Tx } from '@astra/platform';
import { splitPages, verifyManualTables } from '@astra/rating';
import { checkLocation, findBrackets, pageOf } from '@astra/studio';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';
import { checkDocument } from './rating';

/**
 * Agent proposals (E01-F01-S03, E02-F01-S02, E02-F07-S03). Agents submit; the platform verifies every claim
 * against the documents and records; a person reviews and applies. Design: docs/adr/0009.
 */

type Check = { item: string; ok: boolean; detail: string };

interface ProposalRow {
  id: string;
  kind: ProposalKind;
  agent_id: string;
  agent_name: string;
  run_id: string | null;
  requested_by: string;
  subject_type: 'form_edition' | 'rate_manual' | 'document_template' | 'document';
  subject_id: string;
  summary: string;
  content: Record<string, unknown>;
  verification: Check[];
  status: 'open' | 'resolved' | 'withdrawn';
  created_at: Date;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution: Record<string, unknown> | null;
}

const toProposal = (r: ProposalRow): Proposal => ({
  id: r.id,
  kind: r.kind,
  agentId: r.agent_id,
  agentName: r.agent_name,
  runId: r.run_id,
  requestedBy: r.requested_by,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  summary: r.summary,
  content: r.content,
  verification: r.verification,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  resolution: r.resolution,
});

const SELECT = `SELECT p.*, a.name AS agent_name FROM agents.proposals p JOIN agents.agents a ON a.id = p.agent_id`;

/** All problems of a rejected submission, so the agent can correct them together. */
function refuse(problems: string[]): never {
  throw new AppError(
    'validation_failed',
    `The proposal was not stored: ${problems.length} problem${problems.length === 1 ? '' : 's'}. Correct them and submit the whole proposal again.`,
    problems.slice(0, 100).map((m) => ({ code: 'proposal', field: 'proposal', message: m })),
  );
}

interface Validated {
  subjectType: 'form_edition' | 'rate_manual' | 'document_template' | 'document';
  subjectId: string;
  summary: string;
  content: Record<string, unknown>;
  checks: Check[];
  items: number;
}

async function editionOf(tx: Tx, id: string) {
  const e = (await tx.query<{ kind: string; text: string; page_starts: number[]; form_number: string; edition: string }>(`SELECT kind, text, page_starts, form_number, edition FROM studio.form_editions WHERE id = $1`, [id])).rows[0];
  if (!e) throw notFound('The form edition');
  return e;
}

async function validateVariableMap(tx: Tx, s: Extract<SubmitProposal, { kind: 'variable_map' }>): Promise<Validated> {
  const ed = await editionOf(tx, s.editionId);
  if (ed.kind === 'rate_manual') refuse([`${ed.form_number} is a rate manual, not a form or schedule; propose a rate manual instead.`]);
  const problems: string[] = [];
  const checks: Check[] = [];
  const brackets = findBrackets(ed.text, ed.page_starts);
  const keys = new Set<string>();
  const spans = new Set<string>();
  s.items.forEach((item, i) => {
    const v = item.variable;
    const name = v.key || `item ${i + 1}`;
    if (keys.has(v.key)) problems.push(`${name}: the key is used twice.`);
    keys.add(v.key);
    const span = `${v.textStart}-${v.textEnd}`;
    if (spans.has(span)) problems.push(`${name}: the same wording is proposed twice.`);
    spans.add(span);
    const loc = checkLocation(ed.text, v.textStart, v.textEnd, v.excerpt);
    if (loc) {
      problems.push(`${name}: ${loc} (offsets ${v.textStart}-${v.textEnd}). Copy the offsets and excerpt from list_text_brackets or find_text.`);
      return;
    }
    if (v.type === 'insert_placeholder' && v.constraints.source === 'dataset' && !(REFDATA_DATASET_CODES as string[]).includes(v.constraints.dataset!)) {
      problems.push(`${name}: ${v.constraints.dataset} is not a reference dataset. Choose one of ${REFDATA_DATASET_CODES.join(', ')}.`);
      return;
    }
    const page = pageOf(ed.page_starts, v.textStart);
    const found = brackets.find((b) => b.start === v.textStart && b.end === v.textEnd);
    const sug = found?.suggestion;
    const same = sug && sug.type === v.type && JSON.stringify(sug.constraints) === JSON.stringify(v.constraints);
    checks.push({
      item: v.key,
      ok: !sug || !!same,
      detail: `Page ${page}: “${v.excerpt.length > 90 ? `${v.excerpt.slice(0, 90)}…` : v.excerpt}”. ${sug ? (same ? 'Matches the form-reading rule.' : `Differs from the form-reading rule (${sug.type}, ${JSON.stringify(sug.constraints)}): check the type and range.`) : found ? 'The form-reading rule has no suggestion for this wording.' : 'Not a bracketed wording; located by the agent.'}`,
    });
  });
  if (problems.length) refuse(problems);
  return { subjectType: 'form_edition', subjectId: s.editionId, summary: s.summary, content: { items: s.items }, checks, items: s.items.length };
}

async function validateRateManual(tx: Tx, s: Extract<SubmitProposal, { kind: 'rate_manual' }>): Promise<Validated> {
  const ed = await editionOf(tx, s.editionId);
  if (ed.kind !== 'rate_manual') refuse([`${ed.form_number} is a ${ed.kind}, not a rate manual.`]);
  const refs = checkDocument(s.manual.document);
  if (refs.length) refuse(refs);
  const tables = verifyManualTables(s.manual.document, splitPages(ed.text, ed.page_starts));
  const checks: Check[] = tables.map((t) => ({ item: t.tableId, ok: t.ok, detail: t.missing.length ? `${t.detail} Not found: ${t.missing.slice(0, 8).join('; ')}${t.missing.length > 8 ? `; and ${t.missing.length - 8} more` : ''}.` : t.detail }));
  return { subjectType: 'form_edition', subjectId: s.editionId, summary: s.summary, content: { manual: s.manual, uncertainties: s.uncertainties }, checks, items: tables.length };
}

async function validateParity(tx: Tx, s: Extract<SubmitProposal, { kind: 'parity_explanation' }>): Promise<Validated> {
  const m = (await tx.query<{ code: string; document: ManualDocument }>(`SELECT code, document FROM rating.manuals WHERE id = $1`, [s.manualId])).rows[0];
  if (!m) throw notFound('The rate manual');
  const run = (await tx.query<{ results: { caseId: string; name: string; passed: boolean; factorDifferences: { step: string; expected: string; actual: string | null }[] }[] }>(`SELECT results FROM rating.parity_runs WHERE manual_id = $1 ORDER BY ran_at DESC LIMIT 1`, [s.manualId])).rows[0];
  if (!run) refuse(['The manual has no parity run yet. Run the parity cases first.']);
  const cases = (await tx.query<{ id: string; source_row: number | null; expected_factors: Record<string, string> }>(`SELECT id, source_row, expected_factors FROM rating.parity_cases WHERE manual_code = $1`, [m.code])).rows;
  const problems: string[] = [];
  const checks: Check[] = [];
  const seen = new Set<string>();
  for (const item of s.items) {
    const r = run!.results.find((x) => x.caseId === item.caseId);
    const label = r ? `${r.name} / ${item.step}` : item.caseId;
    if (!r) {
      problems.push(`${item.caseId}: not a case of the latest parity run.`);
      continue;
    }
    if (r.passed) {
      problems.push(`${label}: the case passed in the latest run; there is nothing to explain.`);
      continue;
    }
    const diff = r.factorDifferences.find((d) => d.step === item.step);
    if (!diff) {
      problems.push(`${label}: the engine and the workbook do not differ at this step. The steps that differ are: ${r.factorDifferences.map((d) => d.step).join(', ') || 'none (only the final amount differs)'}.`);
      continue;
    }
    const key = `${item.caseId}:${item.step}`;
    if (seen.has(key)) {
      problems.push(`${label}: explained twice.`);
      continue;
    }
    seen.add(key);
    const tableId = item.step.startsWith('table.') ? item.step.slice(6) : null;
    const table = tableId ? m.document.tables.find((t) => t.id === tableId) : null;
    if (!table) problems.push(`${label}: the step is not a table of the manual, so there is no manual page to cite. Say so in the explanation and cite the page of the table the step depends on, if there is one.`);
    else if (item.manualPage !== table.page) problems.push(`${label}: the page of table ${table.id} is “${table.page}”, not “${item.manualPage}”.`);
    const c = cases.find((x) => x.id === item.caseId);
    const column = `factor:${item.step}`;
    if (!c || c.source_row === null) problems.push(`${label}: the case was not imported from a workbook file with row numbers, so there is no cell to cite. Re-import the file.`);
    else if (item.workbookCell.row !== c.source_row || item.workbookCell.column !== column) problems.push(`${label}: the expected value is in row ${c.source_row}, column ${column}, not row ${item.workbookCell.row}, column ${item.workbookCell.column}.`);
    else if (!(column.slice(7) in c.expected_factors)) problems.push(`${label}: the workbook has no expected value in ${column}.`);
    checks.push({ item: `${r.name} / ${item.step}`, ok: true, detail: `Expected ${diff.expected}, engine ${diff.actual ?? 'none'}. Manual page ${item.manualPage}; workbook row ${item.workbookCell.row}, column ${item.workbookCell.column}.` });
  }
  if (problems.length) refuse(problems);
  return { subjectType: 'rate_manual', subjectId: s.manualId, summary: s.summary, content: { items: s.items }, checks, items: s.items.length };
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

async function validateDocumentQuality(tx: Tx, s: Extract<SubmitProposal, { kind: 'document_quality' }>): Promise<Validated> {
  let text: string | null;
  if (s.subjectType === 'document_template') {
    const t = (await tx.query<{ text: string }>(`SELECT text FROM documents.templates WHERE id = $1`, [s.subjectId])).rows[0];
    if (!t) throw notFound('The document template');
    text = t.text;
  } else {
    const d = (await tx.query<{ text: string | null }>(`SELECT text FROM documents.documents WHERE id = $1`, [s.subjectId])).rows[0];
    if (!d) throw notFound('The document');
    text = d.text;
    if (text === null) refuse(['That document was not produced, so there is no text to check.']);
  }
  const hay = squash(text!);
  const problems: string[] = [];
  const checks: Check[] = s.findings.map((f, i) => {
    const at = hay.indexOf(squash(f.quote));
    if (at < 0) problems.push(`f${i + 1}: the quoted text is not in the document: “${f.quote.slice(0, 80)}”. Quote the document exactly.`);
    return { item: `f${i + 1}`, ok: at >= 0, detail: `${f.severity === 'hold' ? 'Holds release' : 'Note'}: ${f.issue} (quoted text found in the document).` };
  });
  if (problems.length) refuse(problems);
  return { subjectType: s.subjectType, subjectId: s.subjectId, summary: s.summary, content: { findings: s.findings }, checks, items: s.findings.length };
}

const itemIds = (p: ProposalRow): string[] => {
  if (p.kind === 'document_quality') return ((p.content as { findings?: unknown[] }).findings ?? []).map((_f, i) => `f${i + 1}`);
  const c = p.content as { items?: { variable?: { key: string }; caseId?: string; step?: string }[]; manual?: { document: { tables: { id: string }[] } } };
  if (p.kind === 'variable_map') return (c.items ?? []).map((i) => i.variable!.key);
  if (p.kind === 'rate_manual') return (c.manual?.document.tables ?? []).map((t) => t.id);
  return (c.items ?? []).map((i) => `${i.caseId}:${i.step}`);
};

const MANAGE: Record<ProposalKind, 'forms:manage' | 'rating:manage' | 'documents:release'> = { variable_map: 'forms:manage', rate_manual: 'rating:manage', parity_explanation: 'rating:manage', document_quality: 'documents:release' };

export const proposalRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.post(
    '/v1/agent-proposals',
    {
      config: { tenancy: 'platform', permission: 'proposals:create' },
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        tags: ['Agent proposals'],
        summary: 'An agent submits a proposal for a person to review (not saved anywhere else until a person applies it)',
        description:
          'Only agents submit proposals, acting for the person who asked. Every claim is checked against the documents and records; a proposal with problems is refused with all of them listed. Stored proposals carry the platform’s own verification of each item.',
        body: SubmitProposalSchema,
        response: { 201: z.object({ proposalId: z.uuid(), status: z.literal('stored'), items: z.number().int(), checks: z.array(z.object({ item: z.string(), ok: z.boolean(), detail: z.string() })), attention: z.number().int() }), ...commonErrors },
      },
    },
    async (request, reply) => {
      const p = request.ctx.principal;
      if (p.kind !== 'agent') throw forbidden('Proposals are submitted by agents acting for a person.');
      const agentId = p.subject.replace(/^agent:/, '');
      const s = request.body;
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const run = (await tx.query<{ id: string; requested_by: string }>(`SELECT id, requested_by FROM agents.runs WHERE agent_id = $1 AND correlation_id = $2 ORDER BY created_at DESC LIMIT 1`, [agentId, request.ctx.correlationId])).rows[0];
        if (!run) throw forbidden('Proposals are submitted during an agent run.');
        const v = s.kind === 'variable_map' ? await validateVariableMap(tx, s) : s.kind === 'rate_manual' ? await validateRateManual(tx, s) : s.kind === 'document_quality' ? await validateDocumentQuality(tx, s) : await validateParity(tx, s);
        // A new proposal for the same subject from the same run replaces the earlier open one.
        await tx.query(
          `UPDATE agents.proposals SET status = 'withdrawn', resolved_by = $4, resolved_at = now(), resolution = '{"reason":"replaced by a newer proposal in the same run"}'
            WHERE run_id = $1 AND kind = $2 AND subject_id = $3 AND status = 'open'`,
          [run.id, s.kind, v.subjectId, p.subject],
        );
        const id = (
          await tx.query<{ id: string }>(
            `INSERT INTO agents.proposals (kind, agent_id, run_id, requested_by, subject_type, subject_id, summary, content, verification)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [s.kind, agentId, run.id, run.requested_by, v.subjectType, v.subjectId, v.summary, JSON.stringify(v.content), JSON.stringify(v.checks)],
          )
        ).rows[0]!.id;
        await publishEvent(tx, request.ctx, AgentProposalRaised, { proposalId: id, kind: s.kind, agentId, subjectId: v.subjectId, items: v.items }, { accountId: null });
        await writeAudit(tx, request.ctx, { action: 'agent_proposal.raised', resourceType: 'agent_proposal', resourceId: id, data: { kind: s.kind, agentId, runId: run.id, items: v.items, needingAttention: v.checks.filter((c) => !c.ok).length } });
        return { proposalId: id, status: 'stored' as const, items: v.items, checks: v.checks, attention: v.checks.filter((c) => !c.ok).length };
      });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/v1/agent-proposals',
    {
      config: { tenancy: 'platform', permission: 'proposals:read' },
      schema: {
        tags: ['Agent proposals'],
        summary: 'Agent proposals, newest first',
        querystring: z.object({ subjectId: z.uuid().optional(), kind: z.enum(['variable_map', 'rate_manual', 'parity_explanation', 'document_quality']).optional(), status: z.enum(['open', 'resolved', 'withdrawn']).optional() }),
        response: { 200: z.object({ items: z.array(ProposalSchema.omit({ content: true })) }), ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<ProposalRow>(
          `${SELECT} WHERE ($1::uuid IS NULL OR p.subject_id = $1) AND ($2::text IS NULL OR p.kind = $2) AND ($3::text IS NULL OR p.status = $3)
            ORDER BY p.created_at DESC LIMIT 100`,
          [q.subjectId ?? null, q.kind ?? null, q.status ?? null],
        ),
      );
      return {
        items: rows.map((r) => {
          const { content: _c, ...rest } = toProposal(r);
          return rest;
        }),
      };
    },
  );

  app.get(
    '/v1/agent-proposals/:proposalId',
    {
      config: { tenancy: 'platform', permission: 'proposals:read' },
      schema: { tags: ['Agent proposals'], summary: 'A proposal with its content and verification', params: z.object({ proposalId: z.uuid() }), response: { 200: ProposalSchema, ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = (await tx.query<ProposalRow>(`${SELECT} WHERE p.id = $1`, [request.params.proposalId])).rows[0];
        if (!r) throw notFound('The proposal');
        return toProposal(r);
      }),
  );

  app.post(
    '/v1/agent-proposals/:proposalId/resolve',
    {
      config: { tenancy: 'platform', permission: 'proposals:read' },
      schema: {
        tags: ['Agent proposals'],
        summary: 'Record what a person did with a proposal: items accepted, corrected and rejected, and what was created from it',
        description: 'Applying an accepted item (saving a variable, loading a draft manual) is done through the ordinary APIs by the person; this records the outcome. Needs the permission to manage what the proposal is about.',
        params: z.object({ proposalId: z.uuid() }),
        body: ResolveProposalSchema,
        response: { 200: ProposalSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const cur = (await tx.query<ProposalRow>(`${SELECT} WHERE p.id = $1 FOR UPDATE OF p`, [request.params.proposalId])).rows[0];
        if (!cur) throw notFound('The proposal');
        const principal = request.ctx.principal;
        if (principal.kind !== 'user') throw forbidden('A proposal is resolved by a person.');
        if (!hasPermission(principal, MANAGE[cur.kind])) throw forbidden(`This needs the ${MANAGE[cur.kind]} permission.`);
        if (cur.status !== 'open') throw conflict(`This proposal is already ${cur.status}.`);
        const b = request.body;
        const known = new Set(itemIds(cur));
        const all = [...b.accepted, ...b.corrected, ...b.rejected];
        const unknown = all.filter((x) => !known.has(x));
        if (unknown.length) throw new AppError('validation_failed', `Not items of this proposal: ${unknown.slice(0, 5).join(', ')}.`);
        if (new Set(all).size !== all.length) throw new AppError('validation_failed', 'An item is in more than one list.');
        const resolution = { accepted: b.accepted, corrected: b.corrected, rejected: b.rejected, appliedTo: b.appliedTo, note: b.note ?? null };
        const row = (
          await tx.query<ProposalRow>(
            `UPDATE agents.proposals SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1
             RETURNING *, (SELECT name FROM agents.agents WHERE id = agent_id) AS agent_name`,
            [cur.id, principal.subject, JSON.stringify(resolution)],
          )
        ).rows[0]!;
        await publishEvent(tx, request.ctx, AgentProposalResolved, { proposalId: cur.id, kind: cur.kind, agentId: cur.agent_id, accepted: b.accepted.length, corrected: b.corrected.length, rejected: b.rejected.length }, { accountId: null });
        await writeAudit(tx, request.ctx, { action: 'agent_proposal.resolved', resourceType: 'agent_proposal', resourceId: cur.id, reason: b.note, data: { kind: cur.kind, agentId: cur.agent_id, accepted: b.accepted.length, corrected: b.corrected.length, rejected: b.rejected.length, appliedTo: b.appliedTo } });
        return toProposal(row);
      }),
  );
};
