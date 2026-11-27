import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AgentProposalResolved,
  ApproveFeedMappingSchema,
  DecideExplanationsSchema,
  FeedMappingDocumentSchema,
  FeedMappingPreviewSchema,
  FeedMappingSchema,
  FeedSampleSchema,
  type FeedMapping,
  type FeedMappingDocument,
  type FeedSample,
  type RejectionExplanation,
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
  type RequestContext,
  type Tx,
} from '@astra/platform';
import { maskCardNumbers, previewMapping } from '@astra/card';
import type { AppDeps } from '../app';
import { findProgramme } from './card';
import { commonErrors } from './shared';

/** Issuer file samples, mappings a person approves, and decisions on the agent's explanations (E21-F04-S01). Design: docs/adr/0021. */

const SAMPLE_LINES = 200;
const SAMPLE_BYTES = 256 * 1024;
const programmeParams = z.object({ programmeId: z.uuid() });

interface SampleRow {
  id: string;
  programme_id: string;
  file_name: string;
  text: string;
  lines: number;
  card_numbers_removed: number;
  created_by: string;
  created_at: Date;
}
const toSample = (r: SampleRow): FeedSample => ({
  id: r.id,
  programmeId: r.programme_id,
  fileName: r.file_name,
  text: r.text,
  lines: r.lines,
  cardNumbersRemoved: r.card_numbers_removed,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

interface MappingRow {
  id: string;
  programme_id: string;
  version: number;
  status: FeedMapping['status'];
  document: FeedMappingDocument;
  proposal_id: string | null;
  approved_by: string;
  approved_at: Date;
}
const toMapping = (r: MappingRow): FeedMapping => ({
  id: r.id,
  programmeId: r.programme_id,
  version: r.version,
  status: r.status,
  document: r.document,
  proposalId: r.proposal_id,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at.toISOString(),
});

const sampleOf = async (tx: Tx, programmeId: string, sampleId: string) => {
  const r = (
    await tx.query<SampleRow>(
      `SELECT * FROM card.feed_samples WHERE id = $1 AND programme_id = $2`,
      [sampleId, programmeId],
    )
  ).rows[0];
  if (!r) throw notFound('The sample');
  return r;
};

const previewHeader = (programmeCode: string) => ({
  programmeCode,
  sequence: 1,
  kind: 'CHANGE' as const,
  asOfDate: new Date().toISOString().slice(0, 10),
});

/** Saves a new approved version of a programme's mapping, checked against a sample of the issuer's file. */
async function approveMapping(
  tx: Tx,
  ctx: RequestContext,
  programme: { id: string; account_id: string; code: string },
  document: FeedMappingDocument,
  sampleId: string,
  proposalId: string | null,
): Promise<MappingRow> {
  const sample = await sampleOf(tx, programme.id, sampleId);
  const preview = await previewMapping(sample.text, document, previewHeader(programme.code));
  if (preview.missingColumns.length)
    throw new AppError(
      'validation_failed',
      `The sample has no column ${preview.missingColumns.join(', ')}.`,
    );
  if (preview.converted === 0)
    throw new AppError(
      'validation_failed',
      'No record of the sample converts with this mapping, so it cannot be approved.',
    );
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`feed-mapping:${programme.id}`]);
  const version = Number(
    (
      await tx.query<{ v: string }>(
        `SELECT coalesce(max(version), 0) + 1 AS v FROM card.feed_mappings WHERE programme_id = $1`,
        [programme.id],
      )
    ).rows[0]!.v,
  );
  await tx.query(
    `UPDATE card.feed_mappings SET status = 'superseded' WHERE programme_id = $1 AND status = 'approved'`,
    [programme.id],
  );
  const row = (
    await tx.query<MappingRow>(
      `INSERT INTO card.feed_mappings (programme_id, account_id, version, document, sample_id, proposal_id, approved_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        programme.id,
        programme.account_id,
        version,
        JSON.stringify(document),
        sampleId,
        proposalId,
        ctx.principal.subject,
      ],
    )
  ).rows[0]!;
  await writeAudit(tx, ctx, {
    action: 'feed_mapping.approved',
    resourceType: 'feed_mapping',
    resourceId: row.id,
    accountId: programme.account_id,
    data: {
      programme: programme.code,
      version,
      proposalId,
      converted: preview.converted,
      rejected: preview.rejected,
    },
  });
  return row;
}

interface ProposalRow {
  id: string;
  kind: string;
  agent_id: string;
  subject_id: string;
  status: string;
  content: Record<string, unknown>;
}

const openProposal = async (
  tx: Tx,
  id: string,
  kind: 'feed_mapping' | 'feed_rejections',
  subjectId: string,
) => {
  const p = (
    await tx.query<ProposalRow>(
      `SELECT id, kind, agent_id, subject_id, status, content FROM agents.proposals WHERE id = $1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!p || p.kind !== kind || p.subject_id !== subjectId) throw notFound('The proposal');
  if (p.status !== 'open') throw conflict(`This proposal is already ${p.status}.`);
  return p;
};

async function resolve(
  tx: Tx,
  ctx: RequestContext,
  p: ProposalRow,
  r: { accepted: string[]; corrected: string[]; rejected: string[]; note: string | null },
) {
  await tx.query(
    `UPDATE agents.proposals SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1`,
    [p.id, ctx.principal.subject, JSON.stringify({ ...r, appliedTo: null })],
  );
  await publishEvent(
    tx,
    ctx,
    AgentProposalResolved,
    {
      proposalId: p.id,
      kind: p.kind as 'feed_mapping' | 'feed_rejections',
      agentId: p.agent_id,
      accepted: r.accepted.length,
      corrected: r.corrected.length,
      rejected: r.rejected.length,
    },
    { accountId: null },
  );
  await writeAudit(tx, ctx, {
    action: 'agent_proposal.resolved',
    resourceType: 'agent_proposal',
    resourceId: p.id,
    reason: r.note ?? undefined,
    data: {
      kind: p.kind,
      agentId: p.agent_id,
      accepted: r.accepted,
      corrected: r.corrected,
      rejected: r.rejected,
    },
  });
}

export const cardMappingRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.post(
    '/v1/card-programmes/:programmeId/samples',
    {
      config: { tenancy: 'account', permission: 'card:feeds' },
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Give the first lines of an issuer’s own file, to draft and check a mapping',
        description:
          'Send the file as text/plain. The first line must name the columns. Only the first 200 lines are kept, and anything that looks like a card number is replaced before they are stored.',
        params: programmeParams,
        querystring: z.object({
          fileName: z.string().trim().min(1).max(200).default('sample.csv'),
        }),
        response: { 201: FeedSampleSchema, ...commonErrors, 413: z.any(), 415: z.any() },
      },
    },
    async (request, reply) => {
      const row = await withTx(deps.pool, request.ctx, async (tx) => {
        const programme = await findProgramme(tx, request.params.programmeId);
        if (
          !request.headers['content-type']?.startsWith('text/plain') ||
          typeof request.body !== 'string'
        )
          throw new AppError('validation_failed', 'Send the file as text/plain.');
        const lines = request.body
          .split('\n')
          .map((l) => l.replace(/\r$/, ''))
          .filter((l) => l.trim() !== '')
          .slice(0, SAMPLE_LINES);
        if (lines.length < 2)
          throw new AppError(
            'validation_failed',
            'The sample needs a line naming the columns and at least one record.',
          );
        const masked = maskCardNumbers(lines.join('\n'));
        if (Buffer.byteLength(masked.text, 'utf8') > SAMPLE_BYTES)
          throw new AppError(
            'validation_failed',
            'The first 200 lines are larger than 256 KB; check the file is a delimited text file.',
          );
        const r = (
          await tx.query<SampleRow>(
            `INSERT INTO card.feed_samples (programme_id, account_id, file_name, text, lines, card_numbers_removed, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
              programme.id,
              programme.account_id,
              request.query.fileName,
              masked.text,
              lines.length,
              masked.removed,
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'feed_sample.stored',
          resourceType: 'feed_sample',
          resourceId: r.id,
          accountId: programme.account_id,
          data: {
            programme: programme.code,
            lines: lines.length,
            cardNumbersRemoved: masked.removed,
          },
        });
        return r;
      });
      return reply.code(201).send(toSample(row));
    },
  );

  app.get(
    '/v1/card-programmes/:programmeId/samples',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Samples of the issuer’s file, newest first',
        params: programmeParams,
        response: { 200: z.object({ items: z.array(FeedSampleSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await findProgramme(tx, request.params.programmeId);
        return {
          items: (
            await tx.query<SampleRow>(
              `SELECT * FROM card.feed_samples WHERE programme_id = $1 ORDER BY created_at DESC LIMIT 10`,
              [request.params.programmeId],
            )
          ).rows.map(toSample),
        };
      }),
  );

  app.get(
    '/v1/card-programmes/:programmeId/samples/:sampleId',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'A sample of the issuer’s file',
        params: programmeParams.extend({ sampleId: z.uuid() }),
        response: { 200: FeedSampleSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) =>
        toSample(await sampleOf(tx, request.params.programmeId, request.params.sampleId)),
      ),
  );

  app.post(
    '/v1/card-programmes/:programmeId/mapping-preview',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary:
          'What a mapping makes of a sample: records converted, and each one the feed rules would reject',
        params: programmeParams,
        body: z.object({ sampleId: z.uuid(), document: FeedMappingDocumentSchema }),
        response: { 200: FeedMappingPreviewSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const programme = await findProgramme(tx, request.params.programmeId);
        const sample = await sampleOf(tx, programme.id, request.body.sampleId);
        return previewMapping(sample.text, request.body.document, previewHeader(programme.code));
      }),
  );

  app.get(
    '/v1/card-programmes/:programmeId/mappings',
    {
      config: { tenancy: 'account', permission: 'card:read' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Approved mappings of the issuer’s file, newest first',
        params: programmeParams,
        response: { 200: z.object({ items: z.array(FeedMappingSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await findProgramme(tx, request.params.programmeId);
        return {
          items: (
            await tx.query<MappingRow>(
              `SELECT * FROM card.feed_mappings WHERE programme_id = $1 ORDER BY version DESC`,
              [request.params.programmeId],
            )
          ).rows.map(toMapping),
        };
      }),
  );

  app.post(
    '/v1/card-programmes/:programmeId/mappings',
    {
      config: { tenancy: 'platform', permission: 'card:manage' },
      schema: {
        tags: ['Card-linked cover'],
        summary: 'Approve a mapping (a person only), from an agent’s proposal or written by hand',
        description:
          'The mapping is checked against the sample and becomes the version used for the issuer’s files. With a proposal, the proposal is resolved, recording whether the mapping was changed first.',
        params: programmeParams,
        body: ApproveFeedMappingSchema,
        response: { 201: FeedMappingSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      if (request.ctx.principal.kind !== 'user')
        throw forbidden('A mapping is approved by a person.');
      const { document, sampleId, proposalId } = request.body;
      const row = await withTx(deps.pool, request.ctx, async (tx) => {
        const programme = await findProgramme(tx, request.params.programmeId);
        const proposal = proposalId
          ? await openProposal(tx, proposalId, 'feed_mapping', programme.id)
          : null;
        const saved = await approveMapping(
          tx,
          request.ctx,
          programme,
          document,
          sampleId,
          proposalId ?? null,
        );
        if (proposal) {
          const same =
            canonicalJson(FeedMappingDocumentSchema.parse(proposal.content.mapping)) ===
            canonicalJson(document);
          await resolve(tx, request.ctx, proposal, {
            accepted: same ? ['mapping'] : [],
            corrected: same ? [] : ['mapping'],
            rejected: [],
            note: null,
          });
        }
        return saved;
      });
      return reply.code(201).send(toMapping(row));
    },
  );

  app.post(
    '/v1/card-programmes/:programmeId/explanations/:proposalId/decision',
    {
      config: { tenancy: 'platform', permission: 'card:manage' },
      schema: {
        tags: ['Card-linked cover'],
        summary:
          'Approve or reject each explanation and fix the agent proposed for a feed’s rejected records (a person only)',
        description:
          'An approved mapping fix becomes the next mapping version; only one mapping change can be approved at a time. An approved issuer fix is recorded for the issuer to act on. Nothing already loaded is changed.',
        params: programmeParams.extend({ proposalId: z.uuid() }),
        body: DecideExplanationsSchema,
        response: {
          200: z.object({
            approved: z.array(z.string()),
            rejected: z.array(z.string()),
            mapping: FeedMappingSchema.nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      if (request.ctx.principal.kind !== 'user') throw forbidden('Fixes are approved by a person.');
      const { decisions, note } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const programme = await findProgramme(tx, request.params.programmeId);
        const row = (
          await tx.query<{
            subject_id: string;
            content: { programmeId?: string; explanations?: RejectionExplanation[] };
          }>(
            `SELECT subject_id, content FROM agents.proposals WHERE id = $1 AND kind = 'feed_rejections'`,
            [request.params.proposalId],
          )
        ).rows[0];
        if (!row || row.content.programmeId !== programme.id) throw notFound('The proposal');
        const proposal = await openProposal(
          tx,
          request.params.proposalId,
          'feed_rejections',
          row.subject_id,
        );
        const explanations = row.content.explanations ?? [];
        const codes = decisions.map((d) => d.code);
        if (new Set(codes).size !== codes.length)
          throw new AppError('validation_failed', 'A code is decided twice.');
        const unknown = codes.filter((c) => !explanations.some((e) => e.code === c));
        if (unknown.length)
          throw new AppError(
            'validation_failed',
            `Not explained by this proposal: ${unknown.join(', ')}.`,
          );
        const undecided = explanations.filter((e) => !codes.includes(e.code)).map((e) => e.code);
        if (undecided.length)
          throw new AppError(
            'validation_failed',
            `Decide every explanation: ${undecided.join(', ')} not decided.`,
          );
        const approved = decisions.filter((d) => d.decision === 'approved').map((d) => d.code);
        const rejected = decisions.filter((d) => d.decision === 'rejected').map((d) => d.code);
        const changes = [
          ...new Map(
            explanations.flatMap((e) =>
              approved.includes(e.code) && e.fix.kind === 'mapping'
                ? [[canonicalJson(e.fix.mapping), e.fix.mapping] as const]
                : [],
            ),
          ).values(),
        ];
        if (changes.length > 1)
          throw new AppError(
            'validation_failed',
            'The approved fixes ask for different mappings. Approve one mapping change, then ask for the rest again.',
          );
        let mapping: MappingRow | null = null;
        if (changes[0]) {
          const sample = (
            await tx.query<{ id: string }>(
              `SELECT id FROM card.feed_samples WHERE programme_id = $1 ORDER BY created_at DESC LIMIT 1`,
              [programme.id],
            )
          ).rows[0];
          if (!sample)
            throw new AppError(
              'precondition_failed',
              'Give a sample of the issuer’s file first, so the changed mapping can be checked.',
            );
          mapping = await approveMapping(
            tx,
            request.ctx,
            programme,
            changes[0],
            sample.id,
            proposal.id,
          );
        }
        await resolve(tx, request.ctx, proposal, {
          accepted: approved,
          corrected: [],
          rejected,
          note: note ?? null,
        });
        return { approved, rejected, mapping: mapping ? toMapping(mapping) : null };
      });
    },
  );
};
