import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AgentDetailSchema,
  AgentReviewSchema,
  AgentRunDetailSchema,
  AgentRunSchema,
  AgentStatusChanged,
  AgentSummarySchema,
  AgentVersionDecided,
  AgentWarrantChanged,
  AUTONOMY_LABELS,
  EvalRunSchema,
  pageOf,
  PageQuerySchema,
  ReasonSchema,
  RUN_STATUSES,
  StartRunRequestSchema,
  WarrantDocumentSchema,
  type AgentReview,
  type AgentRun,
  type AgentSummary,
  type AutonomyLevel,
  type EvalRun,
} from '@astra/contracts';
import {
  AppError,
  decodeCursor,
  encodeCursor,
  hasPermission,
  notFound,
  publishEvent,
  withIdempotency,
  withTx,
  writeAudit,
  type Principal,
  type RequestContext,
  type Tx,
} from '@astra/platform';
import { manifestFor } from '@astra/agents/catalogue';
import type { AppDeps } from '../app';
import { commonErrors, idempotencyHeaders, idempotencyKey, iso } from './shared';

const agentParams = z.object({ agentId: z.string().regex(/^AG-\d{2}$/) });

/** Warrants, budgets and approvals are decisions only people may take (specification section 10.3). */
function requirePerson(principal: Principal): void {
  if (principal.kind !== 'user') {
    throw new AppError('forbidden', 'Only a person can change warrants, budgets or approvals.');
  }
}

interface AgentRow {
  id: string;
  name: string;
  purpose: string;
  owner_role: string;
  autonomy: AutonomyLevel;
  status: 'active' | 'paused' | 'retired';
  status_reason: string | null;
  status_changed_at: Date;
  status_changed_by: string;
  live_version: number | null;
  latest_version: number;
  model: string;
  warrant_version: number | null;
  monthly_limit_usd: string | null;
  alert_threshold_pct: number | null;
  spent_usd: string;
  open_reviews: number;
}

const SUMMARY_SQL = `
  SELECT a.id, a.name, a.purpose, a.owner_role, a.autonomy, a.status, a.status_reason, a.status_changed_at,
         coalesce(a.status_changed_by_name, a.status_changed_by) AS status_changed_by,
         (SELECT max(version) FROM agents.agent_versions v WHERE v.agent_id = a.id AND v.approval_status = 'approved') AS live_version,
         (SELECT max(version) FROM agents.agent_versions v WHERE v.agent_id = a.id) AS latest_version,
         (SELECT model FROM agents.agent_versions v WHERE v.agent_id = a.id ORDER BY version DESC LIMIT 1) AS model,
         (SELECT version FROM agents.warrants w WHERE w.agent_id = a.id AND w.status = 'active') AS warrant_version,
         b.monthly_limit_usd, b.alert_threshold_pct,
         (SELECT coalesce(sum(cost_usd), 0) FROM agents.runs r WHERE r.agent_id = a.id
            AND r.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS spent_usd,
         (SELECT count(*)::int FROM agents.reviews rv WHERE rv.agent_id = a.id AND rv.status = 'open') AS open_reviews
    FROM agents.agents a
    LEFT JOIN agents.budgets b ON b.agent_id = a.id`;

function toSummary(r: AgentRow): AgentSummary {
  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose,
    ownerRole: r.owner_role,
    autonomy: r.autonomy,
    status: r.status,
    statusReason: r.status_reason,
    statusChangedAt: r.status_changed_at.toISOString(),
    statusChangedBy: r.status_changed_by,
    liveVersion: r.live_version,
    latestVersion: r.latest_version,
    model: r.model,
    warrantVersion: r.warrant_version,
    budget:
      r.monthly_limit_usd === null
        ? null
        : {
            monthlyLimitUsd: Number(r.monthly_limit_usd).toFixed(2),
            alertThresholdPct: r.alert_threshold_pct ?? 0,
            spentThisMonthUsd: Number(r.spent_usd).toFixed(4),
          },
    openReviews: r.open_reviews,
  };
}

async function loadSummary(tx: Tx, agentId: string): Promise<AgentRow | null> {
  const { rows } = await tx.query<AgentRow>(`${SUMMARY_SQL} WHERE a.id = $1`, [agentId]);
  return rows[0] ?? null;
}

interface RunRow {
  id: string;
  agent_id: string;
  agent_version: number;
  warrant_version: number | null;
  purpose: 'request' | 'evaluation';
  status: AgentRun['status'];
  stop_reason: string | null;
  requested_by: string;
  requested_by_name: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  model_requested: string | null;
  models_served: string[];
  prompt_version: string | null;
  turns: number;
  tool_calls: number;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
  correlation_id: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const RUN_COLUMNS = `id, agent_id, agent_version, warrant_version, purpose, status, stop_reason, requested_by,
  requested_by_name, input, output, error, model_requested, models_served, prompt_version, turns, tool_calls,
  input_tokens, output_tokens, cost_usd, correlation_id, created_at, started_at, finished_at`;

function toRun(r: RunRow): AgentRun {
  return {
    id: r.id,
    agentId: r.agent_id,
    agentVersion: r.agent_version,
    warrantVersion: r.warrant_version,
    purpose: r.purpose,
    status: r.status,
    stopReason: r.stop_reason,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    input: r.input,
    output: r.output,
    error: r.error,
    modelRequested: r.model_requested,
    modelsServed: r.models_served,
    promptVersion: r.prompt_version,
    turns: r.turns,
    toolCalls: r.tool_calls,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costUsd: Number(r.cost_usd).toFixed(6),
    correlationId: r.correlation_id,
    createdAt: r.created_at.toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

interface ReviewRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  kind: AgentReview['kind'];
  status: 'open' | 'resolved';
  summary: string;
  detail: Record<string, unknown>;
  created_at: Date;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | null;
  resolution: AgentReview['resolution'];
  resolution_note: string | null;
}

const toReview = (r: ReviewRow): AgentReview => ({
  id: r.id,
  agentId: r.agent_id,
  runId: r.run_id,
  kind: r.kind,
  status: r.status,
  summary: r.summary,
  detail: r.detail,
  createdAt: r.created_at.toISOString(),
  resolvedBy: r.resolved_by_name ?? r.resolved_by,
  resolvedAt: iso(r.resolved_at),
  resolution: r.resolution,
  resolutionNote: r.resolution_note,
});

interface EvalRunRow {
  id: string;
  agent_id: string;
  agent_version: number;
  eval_set: string;
  eval_set_version: number;
  status: EvalRun['status'];
  score: string | null;
  passed: boolean | null;
  results: Record<string, unknown>[] | null;
  error: string | null;
  cost_usd: string;
  started_by: string;
  created_at: Date;
  finished_at: Date | null;
}

const toEvalRun = (r: EvalRunRow): EvalRun => ({
  id: r.id,
  agentId: r.agent_id,
  agentVersion: r.agent_version,
  evalSet: r.eval_set,
  evalSetVersion: r.eval_set_version,
  status: r.status,
  score: r.score === null ? null : Number(r.score),
  passed: r.passed,
  results: r.results,
  error: r.error,
  costUsd: Number(r.cost_usd).toFixed(6),
  startedBy: r.started_by,
  createdAt: r.created_at.toISOString(),
  finishedAt: iso(r.finished_at),
});

async function stopQueuedRuns(
  tx: Tx,
  ctx: RequestContext,
  agentId: string,
  agentName: string,
): Promise<number> {
  const { rows } = await tx.query<{
    id: string;
    input: { question?: string };
    requested_by_name: string | null;
  }>(
    `UPDATE agents.runs SET status = 'stopped', stop_reason = 'agent_paused', finished_at = now()
      WHERE agent_id = $1 AND status = 'queued' RETURNING id, input, requested_by_name`,
    [agentId],
  );
  for (const r of rows) {
    await tx.query(
      `INSERT INTO agents.reviews (agent_id, run_id, kind, summary, detail) VALUES ($1, $2, 'agent_paused', $3, $4)`,
      [
        agentId,
        r.id,
        `${agentName} was paused before answering; the request needs a person.`,
        JSON.stringify({ question: r.input.question ?? null, requestedBy: r.requested_by_name }),
      ],
    );
  }
  if (rows.length) {
    await writeAudit(tx, ctx, {
      action: 'agent_runs.routed_to_people',
      resourceType: 'agent',
      resourceId: agentId,
      data: { runs: rows.map((r) => r.id) },
    });
  }
  return rows.length;
}

export const agentRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // ---------- Registry ----------

  app.get(
    '/v1/agents',
    {
      config: { tenancy: 'platform', permission: 'agents:use' },
      schema: {
        tags: ['Agents'],
        summary: 'List registered AI agents',
        response: { 200: z.object({ items: z.array(AgentSummarySchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<AgentRow>(`${SUMMARY_SQL} ORDER BY a.id`),
      );
      return { items: rows.map(toSummary) };
    },
  );

  app.get(
    '/v1/agents/:agentId',
    {
      config: { tenancy: 'platform', permission: 'agents:read' },
      schema: {
        tags: ['Agents'],
        summary: 'Get an agent with its versions, warrant, budget and evaluation sets',
        params: agentParams,
        response: { 200: AgentDetailSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { agentId } = request.params;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const summary = await loadSummary(tx, agentId);
        if (!summary) throw notFound('Agent');
        const versions = await tx.query<{
          version: number;
          config_hash: string;
          model: string;
          prompt_version: string;
          tools: string[];
          data_access: string[];
          effort: string;
          registered_at: Date;
          approval_status: 'pending' | 'approved' | 'rejected' | 'retired';
          approved_by: string | null;
          approved_at: Date | null;
          approval_reason: string | null;
          eval_id: string | null;
          eval_status: string | null;
          eval_score: string | null;
          eval_passed: boolean | null;
          eval_finished_at: Date | null;
        }>(
          `SELECT v.version, v.config_hash, v.model, v.prompt_version, v.tools, v.data_access, v.effort,
                  v.registered_at, v.approval_status, coalesce(v.approved_by_name, v.approved_by) AS approved_by, v.approved_at, v.approval_reason,
                  e.id AS eval_id, e.status AS eval_status, e.score AS eval_score, e.passed AS eval_passed,
                  e.finished_at AS eval_finished_at
             FROM agents.agent_versions v
             LEFT JOIN LATERAL (SELECT * FROM agents.eval_runs er
                                 WHERE er.agent_id = v.agent_id AND er.agent_version = v.version
                                 ORDER BY er.created_at DESC LIMIT 1) e ON true
            WHERE v.agent_id = $1 ORDER BY v.version DESC`,
          [agentId],
        );
        const warrant = await tx.query<{
          version: number;
          document: unknown;
          reason: string;
          created_by: string;
          created_at: Date;
        }>(
          `SELECT version, document, reason, coalesce(created_by_name, created_by) AS created_by, created_at FROM agents.warrants
            WHERE agent_id = $1 AND status = 'active'`,
          [agentId],
        );
        const sets = await tx.query<{
          name: string;
          version: number;
          threshold: string;
          cases: unknown[];
        }>(
          `SELECT DISTINCT ON (name) name, version, threshold, cases FROM agents.eval_sets
            WHERE agent_id = $1 ORDER BY name, version DESC`,
          [agentId],
        );
        const manifest = manifestFor(agentId);
        const w = warrant.rows[0];
        return {
          ...toSummary(summary),
          autonomyLabel: AUTONOMY_LABELS[summary.autonomy],
          versions: versions.rows.map((v) => ({
            version: v.version,
            configHash: v.config_hash,
            model: v.model,
            promptVersion: v.prompt_version,
            tools: v.tools,
            dataAccess: v.data_access,
            effort: v.effort,
            registeredAt: v.registered_at.toISOString(),
            approvalStatus: v.approval_status,
            approvedBy: v.approved_by,
            approvedAt: iso(v.approved_at),
            approvalReason: v.approval_reason,
            latestEvaluation: v.eval_id
              ? {
                  id: v.eval_id,
                  status: v.eval_status!,
                  score: v.eval_score === null ? null : Number(v.eval_score),
                  passed: v.eval_passed,
                  finishedAt: iso(v.eval_finished_at),
                }
              : null,
          })),
          warrant: w
            ? {
                version: w.version,
                document: WarrantDocumentSchema.parse(w.document),
                reason: w.reason,
                createdBy: w.created_by,
                createdAt: w.created_at.toISOString(),
              }
            : null,
          evalSets: sets.rows.map((s) => ({
            name: s.name,
            version: s.version,
            threshold: Number(s.threshold),
            caseCount: s.cases.length,
          })),
          proposedWarrant: manifest?.proposedWarrant ?? null,
          proposedBudget: manifest?.proposedBudget ?? null,
        };
      });
    },
  );

  // ---------- Kill switch ----------

  app.post(
    '/v1/agents/:agentId/status',
    {
      config: { tenancy: 'platform', permission: 'agents:pause' },
      schema: {
        tags: ['Agents'],
        summary: 'Pause or resume an agent (kill switch)',
        description:
          'Pausing takes effect before the agent’s next model or tool call. Its queued requests become review tasks for people.',
        params: agentParams,
        body: z.object({ status: z.enum(['active', 'paused']), reason: ReasonSchema }),
        response: { 200: AgentSummarySchema, ...commonErrors },
      },
    },
    async (request) => {
      const { agentId } = request.params;
      const { status: to, reason } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const cur = await tx.query<{ status: string; name: string }>(
          `SELECT status, name FROM agents.agents WHERE id = $1 FOR UPDATE`,
          [agentId],
        );
        const row = cur.rows[0];
        if (!row) throw notFound('Agent');
        if (row.status === 'retired')
          throw new AppError('conflict', 'A retired agent cannot be changed.');
        if (row.status !== to) {
          await tx.query(
            `UPDATE agents.agents SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4,
                   status_changed_by_name = $5
              WHERE id = $1`,
            [agentId, to, reason, request.ctx.principal.subject, request.ctx.principal.name],
          );
          const routed =
            to === 'paused' ? await stopQueuedRuns(tx, request.ctx, agentId, row.name) : 0;
          await writeAudit(tx, request.ctx, {
            action: to === 'paused' ? 'agent.paused' : 'agent.resumed',
            resourceType: 'agent',
            resourceId: agentId,
            reason,
            data: { from: row.status, to, queuedRunsRoutedToPeople: routed },
          });
          await publishEvent(
            tx,
            request.ctx,
            AgentStatusChanged,
            { agentId, from: row.status, to, reason },
            { accountId: null },
          );
        }
        return toSummary((await loadSummary(tx, agentId))!);
      });
    },
  );

  // ---------- Warrant, budget, approval (people only) ----------

  app.put(
    '/v1/agents/:agentId/warrant',
    {
      config: { tenancy: 'platform', permission: 'agents:manage' },
      schema: {
        tags: ['Agents'],
        summary: 'Set the agent’s warrant (creates a new warrant version)',
        params: agentParams,
        body: z.object({ document: WarrantDocumentSchema, reason: ReasonSchema }),
        response: { 200: AgentDetailSchema.shape.warrant.unwrap(), ...commonErrors },
      },
    },
    async (request) => {
      requirePerson(request.ctx.principal);
      const { agentId } = request.params;
      const { document, reason } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const latest = await tx.query<{ tools: string[]; data_access: string[] }>(
          `SELECT tools, data_access FROM agents.agent_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 1`,
          [agentId],
        );
        const v = latest.rows[0];
        if (!v) throw notFound('Agent');
        const unknownTools = document.tools.map((t) => t.name).filter((n) => !v.tools.includes(n));
        const extraAccess = document.dataAccess.filter((p) => !v.data_access.includes(p));
        const errors = [
          ...(unknownTools.length
            ? [
                {
                  code: 'unknown_tool',
                  message: `The agent has no tool named ${unknownTools.join(', ')}.`,
                  field: 'document.tools',
                },
              ]
            : []),
          ...(extraAccess.length
            ? [
                {
                  code: 'access_not_registered',
                  message: `The agent is not registered for ${extraAccess.join(', ')}.`,
                  field: 'document.dataAccess',
                },
              ]
            : []),
        ];
        if (errors.length) throw new AppError('validation_failed', undefined, errors);

        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `warrant:${agentId}`,
        ]);
        const next = await tx.query<{ v: number }>(
          `SELECT coalesce(max(version), 0) + 1 AS v FROM agents.warrants WHERE agent_id = $1`,
          [agentId],
        );
        const version = next.rows[0]!.v;
        await tx.query(
          `UPDATE agents.warrants SET status = 'superseded' WHERE agent_id = $1 AND status = 'active'`,
          [agentId],
        );
        const { rows } = await tx.query<{ created_at: Date }>(
          `INSERT INTO agents.warrants (agent_id, version, document, status, reason, created_by, created_by_name)
           VALUES ($1, $2, $3, 'active', $4, $5, $6) RETURNING created_at`,
          [
            agentId,
            version,
            JSON.stringify(document),
            reason,
            request.ctx.principal.subject,
            request.ctx.principal.name,
          ],
        );
        await writeAudit(tx, request.ctx, {
          action: 'agent_warrant.set',
          resourceType: 'agent',
          resourceId: agentId,
          reason,
          data: { version, document },
        });
        await publishEvent(
          tx,
          request.ctx,
          AgentWarrantChanged,
          { agentId, version },
          { accountId: null },
        );
        return {
          version,
          document,
          reason,
          createdBy: request.ctx.principal.name ?? request.ctx.principal.subject,
          createdAt: rows[0]!.created_at.toISOString(),
        };
      });
    },
  );

  app.put(
    '/v1/agents/:agentId/budget',
    {
      config: { tenancy: 'platform', permission: 'agents:manage' },
      schema: {
        tags: ['Agents'],
        summary: 'Set the agent’s monthly budget and alert threshold',
        params: agentParams,
        body: z.object({
          monthlyLimitUsd: z.number().min(0).max(100_000),
          alertThresholdPct: z.number().int().min(1).max(100),
          reason: ReasonSchema,
        }),
        response: { 200: AgentSummarySchema, ...commonErrors },
      },
    },
    async (request) => {
      requirePerson(request.ctx.principal);
      const { agentId } = request.params;
      const { monthlyLimitUsd, alertThresholdPct, reason } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        if (!(await loadSummary(tx, agentId))) throw notFound('Agent');
        const before = await tx.query<{ monthly_limit_usd: string; alert_threshold_pct: number }>(
          `SELECT monthly_limit_usd, alert_threshold_pct FROM agents.budgets WHERE agent_id = $1`,
          [agentId],
        );
        await tx.query(
          `INSERT INTO agents.budgets (agent_id, monthly_limit_usd, alert_threshold_pct, updated_by, updated_by_name)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (agent_id) DO UPDATE SET monthly_limit_usd = EXCLUDED.monthly_limit_usd,
             alert_threshold_pct = EXCLUDED.alert_threshold_pct, updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name,
             updated_at = now(), last_alerted_period = NULL`,
          [
            agentId,
            monthlyLimitUsd,
            alertThresholdPct,
            request.ctx.principal.subject,
            request.ctx.principal.name,
          ],
        );
        await writeAudit(tx, request.ctx, {
          action: 'agent_budget.set',
          resourceType: 'agent',
          resourceId: agentId,
          reason,
          data: {
            from: before.rows[0]
              ? {
                  monthlyLimitUsd: before.rows[0].monthly_limit_usd,
                  alertThresholdPct: before.rows[0].alert_threshold_pct,
                }
              : null,
            to: { monthlyLimitUsd, alertThresholdPct },
          },
        });
        return toSummary((await loadSummary(tx, agentId))!);
      });
    },
  );

  app.post(
    '/v1/agents/:agentId/versions/:version/decision',
    {
      config: { tenancy: 'platform', permission: 'agents:manage' },
      schema: {
        tags: ['Agents'],
        summary: 'Approve or reject an agent version',
        description:
          'Approval needs a passed evaluation of this version against the latest version of every evaluation set. Approving retires the previously live version.',
        params: agentParams.extend({ version: z.coerce.number().int().min(1) }),
        body: z.object({ decision: z.enum(['approve', 'reject']), reason: ReasonSchema }),
        response: { 200: AgentSummarySchema, ...commonErrors },
      },
    },
    async (request) => {
      requirePerson(request.ctx.principal);
      const { agentId, version } = request.params;
      const { decision, reason } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const v = await tx.query<{ approval_status: string }>(
          `SELECT approval_status FROM agents.agent_versions WHERE agent_id = $1 AND version = $2 FOR UPDATE`,
          [agentId, version],
        );
        if (!v.rows[0]) throw notFound('Agent version');
        if (v.rows[0].approval_status !== 'pending') {
          throw new AppError(
            'conflict',
            `Version ${version} is already ${v.rows[0].approval_status}.`,
          );
        }
        if (decision === 'approve') {
          const gaps = await tx.query<{ name: string; version: number; passed: boolean | null }>(
            `SELECT s.name, s.version,
                    (SELECT er.passed FROM agents.eval_runs er
                      WHERE er.agent_id = s.agent_id AND er.agent_version = $2 AND er.eval_set = s.name
                        AND er.eval_set_version = s.version AND er.status = 'completed'
                      ORDER BY er.created_at DESC LIMIT 1) AS passed
               FROM (SELECT DISTINCT ON (name) agent_id, name, version FROM agents.eval_sets
                      WHERE agent_id = $1 ORDER BY name, version DESC) s`,
            [agentId, version],
          );
          const failing = gaps.rows.filter((g) => g.passed !== true);
          if (gaps.rows.length === 0 || failing.length) {
            throw new AppError(
              'precondition_failed',
              gaps.rows.length === 0
                ? 'The agent has no evaluation set, so it cannot be approved.'
                : `Version ${version} needs a passed evaluation for: ${failing.map((f) => `${f.name} v${f.version}`).join(', ')}.`,
            );
          }
          await tx.query(
            `UPDATE agents.agent_versions SET approval_status = 'retired' WHERE agent_id = $1 AND approval_status = 'approved'`,
            [agentId],
          );
        }
        await tx.query(
          `UPDATE agents.agent_versions SET approval_status = $3, approved_by = $4, approved_by_name = $6, approved_at = now(), approval_reason = $5
            WHERE agent_id = $1 AND version = $2`,
          [
            agentId,
            version,
            decision === 'approve' ? 'approved' : 'rejected',
            request.ctx.principal.subject,
            reason,
            request.ctx.principal.name,
          ],
        );
        await writeAudit(tx, request.ctx, {
          action: decision === 'approve' ? 'agent_version.approved' : 'agent_version.rejected',
          resourceType: 'agent',
          resourceId: agentId,
          reason,
          data: { version },
        });
        await publishEvent(
          tx,
          request.ctx,
          AgentVersionDecided,
          { agentId, version, decision: decision === 'approve' ? 'approved' : 'rejected' },
          { accountId: null },
        );
        return toSummary((await loadSummary(tx, agentId))!);
      });
    },
  );

  // ---------- Evaluation ----------

  app.post(
    '/v1/agents/:agentId/evaluations',
    {
      config: { tenancy: 'platform', permission: 'agents:manage' },
      schema: {
        tags: ['Agents'],
        summary: 'Run an evaluation set against an agent version',
        description: 'Runs every case through the real model. Each case costs model usage.',
        params: agentParams,
        body: z.object({
          evalSet: z.string().min(1).max(100),
          agentVersion: z.number().int().min(1).optional(),
        }),
        response: { 202: EvalRunSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const { evalSet } = request.body;
      const run = await withTx(deps.pool, request.ctx, async (tx) => {
        const version =
          request.body.agentVersion ??
          (
            await tx.query<{ v: number | null }>(
              `SELECT max(version) AS v FROM agents.agent_versions WHERE agent_id = $1`,
              [agentId],
            )
          ).rows[0]?.v;
        if (!version) throw notFound('Agent');
        const set = await tx.query<{ version: number }>(
          `SELECT version FROM agents.eval_sets WHERE agent_id = $1 AND name = $2 ORDER BY version DESC LIMIT 1`,
          [agentId, evalSet],
        );
        if (!set.rows[0]) throw notFound('Evaluation set');
        const ready = await tx.query<{ warrant: boolean; budget: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM agents.warrants WHERE agent_id = $1 AND status = 'active') AS warrant,
                  EXISTS (SELECT 1 FROM agents.budgets WHERE agent_id = $1) AS budget`,
          [agentId],
        );
        if (!ready.rows[0]!.warrant || !ready.rows[0]!.budget) {
          throw new AppError(
            'precondition_failed',
            'Set the agent’s warrant and budget before evaluating it.',
          );
        }
        const { rows } = await tx.query<EvalRunRow>(
          `INSERT INTO agents.eval_runs (agent_id, agent_version, eval_set, eval_set_version, started_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [agentId, version, evalSet, set.rows[0].version, request.ctx.principal.subject],
        );
        await writeAudit(tx, request.ctx, {
          action: 'agent_evaluation.requested',
          resourceType: 'agent',
          resourceId: agentId,
          data: {
            evalRunId: rows[0]!.id,
            agentVersion: version,
            evalSet: `${evalSet}@${set.rows[0].version}`,
          },
        });
        return toEvalRun(rows[0]!);
      });
      return reply.code(202).send(run);
    },
  );

  app.get(
    '/v1/agents/:agentId/evaluations',
    {
      config: { tenancy: 'platform', permission: 'agents:read' },
      schema: {
        tags: ['Agents'],
        summary: 'List evaluation runs for an agent, newest first',
        params: agentParams,
        response: { 200: z.object({ items: z.array(EvalRunSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<EvalRunRow>(
          `SELECT * FROM agents.eval_runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [request.params.agentId],
        ),
      );
      return { items: rows.map(toEvalRun) };
    },
  );

  // ---------- Runs ----------

  app.post(
    '/v1/agents/:agentId/runs',
    {
      config: { tenancy: 'platform', permission: 'agents:use' },
      schema: {
        tags: ['Agents'],
        summary: 'Ask an agent a question',
        description:
          'Queues a run on the agent’s approved version. The agent acts with at most your own permissions. Poll the run for its answer.',
        headers: idempotencyHeaders,
        params: agentParams,
        body: StartRunRequestSchema,
        response: { 202: AgentRunSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const p = request.ctx.principal;
      const result = await withTx(deps.pool, request.ctx, (tx) =>
        withIdempotency(
          tx,
          request.ctx,
          {
            key: idempotencyKey(request),
            method: 'POST',
            path: `/v1/agents/${agentId}/runs`,
            body: request.body,
            accountId: null,
          },
          async () => {
            const summary = await loadSummary(tx, agentId);
            if (!summary) throw notFound('Agent');
            if (summary.status !== 'active')
              throw new AppError('conflict', `${summary.name} is ${summary.status}.`);
            if (!summary.live_version) {
              throw new AppError('conflict', `${summary.name} has no approved version yet.`);
            }
            const { rows } = await tx.query<RunRow>(
              `INSERT INTO agents.runs
                 (id, agent_id, agent_version, purpose, requested_by, requested_by_name, account_scope,
                  permissions, input, correlation_id)
               VALUES ($1, $2, $3, 'request', $4, $5, $6, $7, $8, $9) RETURNING ${RUN_COLUMNS}`,
              [
                randomUUID(),
                agentId,
                summary.live_version,
                p.subject,
                p.name,
                p.accountScope.type === 'all' ? '*' : p.accountScope.accountIds.join(','),
                p.permissions,
                JSON.stringify({ question: request.body.question }),
                request.ctx.correlationId,
              ],
            );
            const run = rows[0]!;
            await writeAudit(tx, request.ctx, {
              action: 'agent_run.requested',
              resourceType: 'agent_run',
              resourceId: run.id,
              data: { agentId, agentVersion: summary.live_version },
            });
            return { status: 202, body: toRun(run) };
          },
        ),
      );
      return reply
        .code(202)
        .header('location', `/v1/agent-runs/${result.body.id}`)
        .send(result.body);
    },
  );

  const canSeeAllRuns = (p: Principal) => hasPermission(p, 'agents:read');

  app.get(
    '/v1/agent-runs',
    {
      config: { tenancy: 'platform', permission: 'agents:use' },
      schema: {
        tags: ['Agents'],
        summary: 'List agent runs, newest first (your own unless you can read all agent activity)',
        querystring: PageQuerySchema.extend({
          agentId: z
            .string()
            .regex(/^AG-\d{2}$/)
            .optional(),
          status: z.enum(RUN_STATUSES).optional(),
          purpose: z.enum(['request', 'evaluation']).optional(),
        }),
        response: { 200: pageOf(AgentRunSchema), ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const after = decodeCursor(q.cursor, 2);
      const mine = canSeeAllRuns(request.ctx.principal) ? null : request.ctx.principal.subject;
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM agents.runs
            WHERE ($1::text IS NULL OR agent_id = $1)
              AND ($2::text IS NULL OR status = $2)
              AND ($3::text IS NULL OR purpose = $3)
              AND ($4::text IS NULL OR requested_by = $4)
              AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $7`,
          [
            q.agentId ?? null,
            q.status ?? null,
            q.purpose ?? null,
            mine,
            after?.[0] ?? null,
            after?.[1] ?? null,
            q.limit + 1,
          ],
        ),
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(toRun),
        nextCursor:
          rows.length > q.limit && last
            ? encodeCursor([last.created_at.toISOString(), last.id])
            : null,
      };
    },
  );

  app.get(
    '/v1/agent-runs/:runId',
    {
      config: { tenancy: 'platform', permission: 'agents:use' },
      schema: {
        tags: ['Agents'],
        summary: 'Get an agent run with its full step record',
        params: z.object({ runId: z.uuid() }),
        response: { 200: AgentRunDetailSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { runId } = request.params;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const { rows } = await tx.query<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM agents.runs WHERE id = $1`,
          [runId],
        );
        const run = rows[0];
        if (
          !run ||
          (!canSeeAllRuns(request.ctx.principal) &&
            run.requested_by !== request.ctx.principal.subject)
        ) {
          throw notFound('Agent run');
        }
        const steps = await tx.query<{
          seq: number;
          at: Date;
          kind: string;
          name: string | null;
          decision: string | null;
          detail: Record<string, unknown>;
        }>(
          `SELECT seq, at, kind, name, decision, detail FROM agents.run_steps WHERE run_id = $1 ORDER BY seq`,
          [runId],
        );
        return {
          ...toRun(run),
          steps: steps.rows.map((s) => ({ ...s, at: s.at.toISOString() })),
        };
      });
    },
  );

  // ---------- Work routed to people ----------

  app.get(
    '/v1/agent-reviews',
    {
      config: { tenancy: 'platform', permission: 'agents:review' },
      schema: {
        tags: ['Agents'],
        summary: 'List work routed from agents to people',
        querystring: PageQuerySchema.extend({
          status: z.enum(['open', 'resolved']).optional(),
          agentId: z
            .string()
            .regex(/^AG-\d{2}$/)
            .optional(),
        }),
        response: { 200: pageOf(AgentReviewSchema), ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const after = decodeCursor(q.cursor, 2);
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<ReviewRow>(
          `SELECT * FROM agents.reviews
            WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR agent_id = $2)
              AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
            ORDER BY created_at DESC, id DESC LIMIT $5`,
          [
            q.status ?? null,
            q.agentId ?? null,
            after?.[0] ?? null,
            after?.[1] ?? null,
            q.limit + 1,
          ],
        ),
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(toReview),
        nextCursor:
          rows.length > q.limit && last
            ? encodeCursor([last.created_at.toISOString(), last.id])
            : null,
      };
    },
  );

  app.post(
    '/v1/agent-reviews/:reviewId/resolve',
    {
      config: { tenancy: 'platform', permission: 'agents:review' },
      schema: {
        tags: ['Agents'],
        summary: 'Resolve a review task',
        params: z.object({ reviewId: z.uuid() }),
        body: z.object({
          resolution: z.enum(['accepted', 'rejected', 'handled']),
          note: ReasonSchema,
        }),
        response: { 200: AgentReviewSchema, ...commonErrors },
      },
    },
    async (request) => {
      requirePerson(request.ctx.principal);
      const { reviewId } = request.params;
      const { resolution, note } = request.body;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const { rows } = await tx.query<ReviewRow>(
          `UPDATE agents.reviews SET status = 'resolved', resolution = $2, resolution_note = $3, resolved_by = $4, resolved_by_name = $5,
                  resolved_at = now()
            WHERE id = $1 AND status = 'open' RETURNING *`,
          [reviewId, resolution, note, request.ctx.principal.subject, request.ctx.principal.name],
        );
        const row = rows[0];
        if (!row) {
          const exists = await tx.query(`SELECT 1 FROM agents.reviews WHERE id = $1`, [reviewId]);
          if (exists.rowCount) throw new AppError('conflict', 'This review is already resolved.');
          throw notFound('Review');
        }
        await writeAudit(tx, request.ctx, {
          action: 'agent_review.resolved',
          resourceType: 'agent_review',
          resourceId: reviewId,
          reason: note,
          data: { agentId: row.agent_id, runId: row.run_id, kind: row.kind, resolution },
        });
        return toReview(row);
      });
    },
  );
};
