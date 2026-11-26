import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AgentRunReviewSchema,
  AssignTaskSchema,
  OutputDecisionInputSchema,
  ReferralSummaryInputSchema,
  ReferralSummarySchema,
  SearchResultSchema,
  SlaPolicyInputSchema,
  SlaPolicySchema,
  TASK_SOURCES,
  TaskListSchema,
  TaskSourceSchema,
  timerState,
  type ReferralSummary,
  type Task,
} from '@astra/contracts';
import { AppError, conflict, forbidden, hasPermission, notFound, withTx, writeAudit } from '@astra/platform';
import type { AppDeps } from '../app';
import { commonErrors, escapeLike } from './shared';

/** Policy search, the work queue, referral summaries and the record of what people decide about agent output. Design: docs/adr/0016. */

const PRIORITY_RANK = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

interface QueueRow {
  source_type: Task['sourceType'];
  source_id: string;
  title: string;
  summary: string;
  account_id: string | null;
  created_at: Date;
  link: string;
  priority: Task['priority'];
  due_at: Date;
  target_hours: number;
  owner: string | null;
  owner_name: string | null;
  assigned_at: Date | null;
  minutes_left: string;
}

const toTask = (r: QueueRow): Task => {
  const minutesLeft = Number(r.minutes_left);
  return {
    sourceType: r.source_type,
    sourceId: r.source_id,
    title: r.title,
    summary: r.summary,
    accountId: r.account_id,
    createdAt: r.created_at.toISOString(),
    link: r.link,
    priority: r.priority,
    targetHours: r.target_hours,
    dueAt: r.due_at.toISOString(),
    timer: timerState(minutesLeft, r.target_hours),
    minutesLeft,
    owner: r.owner,
    ownerName: r.owner_name,
    assignedAt: r.assigned_at ? r.assigned_at.toISOString() : null,
  };
};

interface SummaryRow {
  id: string;
  referral_id: string;
  run_id: string | null;
  agent_id: string | null;
  summary: string;
  rules_cited: string[];
  suggested: ReferralSummary['suggested'];
  verification: ReferralSummary['verification'];
  created_by: string;
  created_at: Date;
  d_decision: 'accepted' | 'edited' | 'rejected' | null;
  d_edited: { summary: string } | null;
  d_reason: string | null;
  d_by: string | null;
  d_at: Date | null;
}

const SUMMARY_SELECT = `SELECT s.id, s.referral_id, s.run_id, r.agent_id, s.summary, s.rules_cited, s.suggested, s.verification, s.created_by, s.created_at,
         d.decision AS d_decision, d.edited AS d_edited, d.reason AS d_reason, d.decided_by AS d_by, d.decided_at AS d_at
    FROM underwriting.referral_summaries s
    LEFT JOIN agents.runs r ON r.id = s.run_id
    LEFT JOIN agents.output_decisions d ON d.subject_type = 'referral_summary' AND d.subject_id = s.id`;

const toSummary = (r: SummaryRow): ReferralSummary => ({
  id: r.id,
  referralId: r.referral_id,
  runId: r.run_id,
  agentId: r.agent_id,
  summary: r.summary,
  rulesCited: r.rules_cited,
  suggested: r.suggested,
  verification: r.verification,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  decision: r.d_decision
    ? { decision: r.d_decision, edited: r.d_edited, reason: r.d_reason, decidedBy: r.d_by!, decidedAt: r.d_at!.toISOString() }
    : null,
});

export const workbenchRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // ---------------- Search (E11-F01-S01) ----------------

  app.get(
    '/v1/search',
    {
      config: { tenancy: 'account', permission: 'policies:read' },
      schema: {
        tags: ['Workbench'],
        summary: 'Find a policy by number, traveller, account or trip',
        description:
          'Matches part of a policy number, a traveller’s name, an account’s name or code, a trip’s destination (country code or region) or its departure or return date (YYYY-MM-DD). Only policies the caller may see are returned: row-level security applies the caller’s account scope.',
        querystring: z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(50).default(20) }),
        response: { 200: SearchResultSchema, ...commonErrors },
      },
    },
    async (request) => {
      const started = performance.now();
      const q = request.query.q;
      const like = `%${escapeLike(q.toLowerCase())}%`;
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<{
          id: string; number: string; status: 'active' | 'cancelled' | 'expired'; account_id: string; account_name: string; plan_code: string;
          travellers: string[]; departure: string | null; ret: string | null; destinations: string[]; matched: string[];
        }>(
          // Each way of matching finds its candidates through its own index; the policies are then read once.
          `WITH hits AS (
             SELECT p.id, 'number' AS m FROM policies.policies p WHERE lower(p.number) LIKE $1
             UNION ALL
             SELECT t.policy_id, 'traveller' FROM policies.policy_travellers t WHERE lower(t.first_name || ' ' || t.last_name) LIKE $1
             UNION ALL
             SELECT p.id, 'account' FROM platform.accounts a JOIN policies.policies p ON p.account_id = a.id WHERE lower(a.name) LIKE $1 OR lower(a.code) LIKE $1
             UNION ALL
             SELECT p.id, 'trip' FROM policies.quotes qt JOIN policies.policies p ON p.quote_id = qt.id
              WHERE lower((qt.request->'trip'->'destinations')::text) LIKE $1 OR qt.request->'trip'->>'departureDate' = $2 OR qt.request->'trip'->>'returnDate' = $2
           ), found AS (
             SELECT id, array_agg(DISTINCT m) AS matched FROM hits GROUP BY id
           )
           SELECT p.id, p.number, p.status, p.account_id, a.name AS account_name, pl.code AS plan_code,
                  array(SELECT t.first_name || ' ' || t.last_name FROM policies.policy_travellers t WHERE t.policy_id = p.id ORDER BY t.traveller_id) AS travellers,
                  qt.request->'trip'->>'departureDate' AS departure, qt.request->'trip'->>'returnDate' AS ret,
                  array(SELECT coalesce(d->>'country', '') || CASE WHEN d->>'country' IS NOT NULL AND d->>'region' IS NOT NULL THEN ' · ' ELSE '' END || coalesce(d->>'region', '')
                          FROM jsonb_array_elements(coalesce(qt.request->'trip'->'destinations', '[]'::jsonb)) d) AS destinations,
                  f.matched
             FROM found f
             JOIN policies.policies p ON p.id = f.id
             JOIN platform.accounts a ON a.id = p.account_id
             JOIN plans.plans pl ON pl.id = p.plan_id
             JOIN policies.quotes qt ON qt.id = p.quote_id
            ORDER BY ('number' = ANY (f.matched)) DESC, p.created_at DESC
            LIMIT $3`,
          [like, q, request.query.limit],
        ),
      );
      return {
        query: q,
        items: rows.map((r) => ({
          policyId: r.id,
          number: r.number,
          status: r.status,
          accountId: r.account_id,
          accountName: r.account_name,
          planCode: r.plan_code,
          travellers: r.travellers,
          departureDate: r.departure,
          returnDate: r.ret,
          destinations: r.destinations,
          matchedOn: r.matched as ('number' | 'traveller' | 'account' | 'trip')[],
        })),
        tookMs: Math.round(performance.now() - started),
      };
    },
  );

  // ---------------- Work queue (E11-F02-S01) ----------------

  app.get(
    '/v1/tasks',
    {
      config: { tenancy: 'platform', permission: 'tasks:read' },
      schema: {
        tags: ['Workbench'],
        summary: 'Everything waiting for a person: referrals, sanctions holds, agent proposals, agent reviews and failed deliveries',
        description:
          'One queue, most urgent first. Every task shows its priority, the time left against its timer, and who holds it. Work leaves the queue when it is finished in its own screen.',
        querystring: z.object({
          source: TaskSourceSchema.optional(),
          owner: z.enum(['me', 'unassigned']).optional(),
          timer: z.enum(['on_track', 'at_risk', 'overdue']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
        response: { 200: TaskListSchema, ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const me = request.ctx.principal.subject;
      const minutes = `floor(extract(epoch FROM (due_at - now())) / 60)`;
      const where = `($1::text IS NULL OR source_type = $1)
        AND ($2::text IS NULL OR ($2 = 'me' AND owner = $3) OR ($2 = 'unassigned' AND owner IS NULL))
        AND ($4::text IS NULL OR ($4 = 'overdue' AND ${minutes} < 0)
             OR ($4 = 'at_risk' AND ${minutes} >= 0 AND ${minutes} <= target_hours * 15)
             OR ($4 = 'on_track' AND ${minutes} > target_hours * 15))`;
      const params = [q.source ?? null, q.owner ?? null, me, q.timer ?? null];
      const [list, counts] = await withTx(deps.pool, request.ctx, async (tx) =>
        Promise.all([
          tx.query<QueueRow>(`SELECT *, ${minutes} AS minutes_left FROM workbench.queue WHERE ${where} ORDER BY ${PRIORITY_RANK}, due_at, source_id LIMIT $5`, [...params, q.limit]),
          tx.query<{ total: string; overdue: string; at_risk: string; unassigned: string }>(
            `SELECT count(*) AS total, count(*) FILTER (WHERE ${minutes} < 0) AS overdue,
                    count(*) FILTER (WHERE ${minutes} >= 0 AND ${minutes} <= target_hours * 15) AS at_risk,
                    count(*) FILTER (WHERE owner IS NULL) AS unassigned
               FROM workbench.queue WHERE ${where}`,
            params,
          ),
        ]),
      );
      const c = counts.rows[0]!;
      return { items: list.rows.map(toTask), total: Number(c.total), counts: { overdue: Number(c.overdue), atRisk: Number(c.at_risk), unassigned: Number(c.unassigned) } };
    },
  );

  app.get(
    '/v1/task-assignees',
    {
      config: { tenancy: 'platform', permission: 'tasks:read' },
      schema: {
        tags: ['Workbench'],
        summary: 'People who can be given work',
        description: 'People who have signed in to the workbench and may take work from the queue, with what they hold now.',
        response: { 200: z.object({ items: z.array(z.object({ subject: z.string(), name: z.string().nullable(), roles: z.array(z.string()), open: z.number().int() })) }), ...commonErrors },
      },
    },
    async (request) => {
      const r = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<{ subject: string; name: string | null; roles: string[]; open: string }>(
          `SELECT s.subject, s.name, s.roles, (SELECT count(*) FROM workbench.queue q WHERE q.owner = s.subject) AS open
             FROM workbench.staff s WHERE 'tasks:work' = ANY (s.permissions) ORDER BY lower(coalesce(s.name, s.subject))`,
        ),
      );
      return { items: r.rows.map((x) => ({ subject: x.subject, name: x.name, roles: x.roles, open: Number(x.open) })) };
    },
  );

  app.put(
    '/v1/tasks/:sourceType/:sourceId/assignment',
    {
      config: { tenancy: 'platform', permission: 'tasks:work' },
      schema: {
        tags: ['Workbench'],
        summary: 'Take a task, hand it back, or (with tasks:assign) give it to someone else',
        description: 'A null owner hands the task back to the queue. Taking an unassigned task or handing back your own needs tasks:work; moving work to or from someone else needs tasks:assign.',
        params: z.object({ sourceType: TaskSourceSchema, sourceId: z.uuid() }),
        body: AssignTaskSchema,
        response: { 200: z.object({ sourceType: TaskSourceSchema, sourceId: z.uuid(), owner: z.string().nullable(), ownerName: z.string().nullable() }), ...commonErrors },
      },
    },
    async (request) => {
      const { sourceType, sourceId } = request.params;
      const p = request.ctx.principal;
      if (p.kind !== 'user') throw forbidden('Work is assigned by people.');
      const supervisor = hasPermission(p, 'tasks:assign');
      return withTx(deps.pool, request.ctx, async (tx) => {
        const task = (await tx.query<{ owner: string | null }>(`SELECT owner FROM workbench.queue WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId])).rows[0];
        if (!task) throw notFound('The task');
        const { owner } = request.body;
        if (!supervisor) {
          if (owner !== null && owner !== p.subject) throw forbidden('You can take work for yourself. A supervisor assigns it to someone else.');
          if (task.owner && task.owner !== p.subject) throw conflict('Someone else holds this task. A supervisor can reassign it.');
        }
        if (owner === null) {
          await tx.query(`DELETE FROM workbench.assignments WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId]);
          await writeAudit(tx, request.ctx, { action: 'task.released', resourceType: 'task', resourceId: sourceId, data: { sourceType, previousOwner: task.owner } });
          return { sourceType, sourceId, owner: null, ownerName: null };
        }
        let ownerName = owner === p.subject ? p.name : (request.body.ownerName ?? null);
        if (owner !== p.subject) {
          const person = (await tx.query<{ name: string | null; permissions: string[] }>(`SELECT name, permissions FROM workbench.staff WHERE subject = $1`, [owner])).rows[0];
          if (!person) throw new AppError('validation_failed', 'That person has not signed in to the workbench, so work cannot be given to them yet.');
          if (!person.permissions.includes('tasks:work')) throw new AppError('validation_failed', 'That person is not allowed to take work from the queue.');
          ownerName = person.name;
        }
        await tx.query(
          `INSERT INTO workbench.assignments (source_type, source_id, owner, owner_name, assigned_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (source_type, source_id) DO UPDATE SET owner = EXCLUDED.owner, owner_name = EXCLUDED.owner_name, assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
          [sourceType, sourceId, owner, ownerName, p.subject],
        );
        await writeAudit(tx, request.ctx, { action: task.owner ? 'task.reassigned' : 'task.assigned', resourceType: 'task', resourceId: sourceId, data: { sourceType, previousOwner: task.owner, owner } });
        return { sourceType, sourceId, owner, ownerName };
      });
    },
  );

  app.get(
    '/v1/task-sla',
    {
      config: { tenancy: 'platform', permission: 'tasks:read' },
      schema: { tags: ['Workbench'], summary: 'How long each kind of work may wait, and its priority', response: { 200: z.object({ items: z.array(SlaPolicySchema) }), ...commonErrors } },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<{ source_type: Task['sourceType']; priority: Task['priority']; target_hours: number; updated_by: string; updated_at: Date }>(`SELECT * FROM workbench.sla_policies`),
      );
      const order = new Map(TASK_SOURCES.map((s, i) => [s, i]));
      return {
        items: rows
          .sort((a, b) => order.get(a.source_type)! - order.get(b.source_type)!)
          .map((r) => ({ sourceType: r.source_type, priority: r.priority, targetHours: r.target_hours, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() })),
      };
    },
  );

  app.put(
    '/v1/task-sla/:sourceType',
    {
      config: { tenancy: 'platform', permission: 'tasks:assign' },
      schema: {
        tags: ['Workbench'],
        summary: 'Set how long a kind of work may wait and its priority',
        params: z.object({ sourceType: TaskSourceSchema }),
        body: SlaPolicyInputSchema,
        response: { 200: SlaPolicySchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{ source_type: Task['sourceType']; priority: Task['priority']; target_hours: number; updated_by: string; updated_at: Date }>(
            `UPDATE workbench.sla_policies SET priority = $2, target_hours = $3, updated_by = $4, updated_at = now() WHERE source_type = $1 RETURNING *`,
            [request.params.sourceType, request.body.priority, request.body.targetHours, request.ctx.principal.subject],
          )
        ).rows[0];
        if (!r) throw notFound('The timer');
        await writeAudit(tx, request.ctx, { action: 'task_sla.changed', resourceType: 'task_sla', resourceId: r.source_type, data: { priority: r.priority, targetHours: r.target_hours } });
        return { sourceType: r.source_type, priority: r.priority, targetHours: r.target_hours, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() };
      }),
  );

  // ---------------- AG-04 referral summaries (E03-F05-S01) ----------------

  app.post(
    '/v1/referrals/:referralId/summaries',
    {
      config: { tenancy: 'platform', permission: 'underwriting:evaluate' },
      schema: {
        tags: ['Workbench'],
        summary: 'The Underwriting Referral agent submits its summary of a referral',
        description:
          'Only agents submit summaries, acting for the underwriter who asked. A summary may cite only rules that fired on this referral, and only underwriting referrals are summarised: a sanctions hold is never summarised by an agent. The summary never decides the referral; an underwriter reads it, and a decline is always a person’s decision.',
        params: z.object({ referralId: z.uuid() }),
        body: ReferralSummaryInputSchema,
        response: { 201: ReferralSummarySchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const p = request.ctx.principal;
      if (p.kind !== 'agent') throw forbidden('Summaries are submitted by agents acting for a person.');
      const agentId = p.subject.replace(/^agent:/, '');
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const run = (await tx.query<{ id: string }>(`SELECT id FROM agents.runs WHERE agent_id = $1 AND correlation_id = $2 ORDER BY created_at DESC LIMIT 1`, [agentId, request.ctx.correlationId])).rows[0];
        if (!run) throw forbidden('Summaries are submitted during an agent run.');
        const ref = (await tx.query<{ id: string; kind: string; status: string; evaluation: { referrals?: { rule: string }[] } }>(`SELECT id, kind, status, evaluation FROM underwriting.referrals WHERE id = $1`, [request.params.referralId])).rows[0];
        if (!ref) throw notFound('The referral');
        if (ref.kind !== 'underwriting') throw forbidden('A sanctions hold is reviewed by a person; an agent does not summarise it.');
        if (ref.status !== 'open') throw conflict(`This referral is already ${ref.status}.`);
        const fired = new Set((ref.evaluation.referrals ?? []).map((x) => x.rule));
        const rulesChecked = request.body.rulesCited.map((code) => ({ code, fired: fired.has(code) }));
        const unknown = rulesChecked.filter((x) => !x.fired).map((x) => x.code);
        if (unknown.length) {
          throw new AppError('validation_failed', `The summary cites ${unknown.join(', ')}, which did not fire on this referral. The rules that fired are ${[...fired].join(', ') || 'none'}.`, unknown.map((c) => ({ code: 'rule_not_fired', field: 'rulesCited', message: c })));
        }
        const row = (
          await tx.query<{ id: string }>(
            `INSERT INTO underwriting.referral_summaries (referral_id, run_id, summary, rules_cited, suggested, verification, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [ref.id, run.id, request.body.summary, request.body.rulesCited, request.body.suggested, JSON.stringify({ rulesChecked, allCitedRulesFired: true }), p.subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, { action: 'referral_summary.written', resourceType: 'referral', resourceId: ref.id, data: { summaryId: row.id, agentId, runId: run.id, suggested: request.body.suggested, rulesCited: request.body.rulesCited } });
        return (await tx.query<SummaryRow>(`${SUMMARY_SELECT} WHERE s.id = $1`, [row.id])).rows[0]!;
      });
      return reply.code(201).send(toSummary(out));
    },
  );

  app.get(
    '/v1/referrals/:referralId/summaries',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: {
        tags: ['Workbench'],
        summary: 'The agent’s summaries of a referral, newest first, with what an underwriter decided about each',
        params: z.object({ referralId: z.uuid() }),
        response: { 200: z.object({ items: z.array(ReferralSummarySchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) => tx.query<SummaryRow>(`${SUMMARY_SELECT} WHERE s.referral_id = $1 ORDER BY s.created_at DESC`, [request.params.referralId]));
      return { items: rows.map(toSummary) };
    },
  );

  // ---------------- What a person decides about agent output (E11-F02-S02) ----------------

  app.post(
    '/v1/referral-summaries/:summaryId/decision',
    {
      config: { tenancy: 'platform', permission: 'referrals:decide' },
      schema: {
        tags: ['Workbench'],
        summary: 'Accept, edit or reject the agent’s summary, recording why for evaluation',
        description: 'Recorded once and never changed. This is a decision about the agent’s output, not about the referral: the referral is decided on its own screen.',
        params: z.object({ summaryId: z.uuid() }),
        body: OutputDecisionInputSchema,
        response: { 200: ReferralSummarySchema, ...commonErrors },
      },
    },
    async (request) => {
      const p = request.ctx.principal;
      if (p.kind !== 'user') throw forbidden('Agent output is judged by a person.');
      const b = request.body;
      const row = await withTx(deps.pool, request.ctx, async (tx) => {
        const s = (await tx.query<SummaryRow>(`${SUMMARY_SELECT} WHERE s.id = $1`, [request.params.summaryId])).rows[0];
        if (!s || !s.run_id || !s.agent_id) throw notFound('The summary');
        if (s.d_decision) throw conflict(`This summary was already ${s.d_decision}.`);
        await tx.query(
          `INSERT INTO agents.output_decisions (run_id, agent_id, subject_type, subject_id, decision, original, edited, reason, decided_by)
           VALUES ($1, $2, 'referral_summary', $3, $4, $5, $6, $7, $8)`,
          [s.run_id, s.agent_id, s.id, b.decision, JSON.stringify({ summary: s.summary, rulesCited: s.rules_cited, suggested: s.suggested }), b.decision === 'edited' ? JSON.stringify({ summary: b.editedSummary }) : null, b.reason ?? null, p.subject],
        );
        await writeAudit(tx, request.ctx, { action: `referral_summary.${b.decision}`, resourceType: 'referral', resourceId: s.referral_id, reason: b.reason, data: { summaryId: s.id, agentId: s.agent_id, runId: s.run_id } });
        return (await tx.query<SummaryRow>(`${SUMMARY_SELECT} WHERE s.id = $1`, [s.id])).rows[0]!;
      });
      return toSummary(row);
    },
  );

  app.get(
    '/v1/agent-runs/:runId/review',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: {
        tags: ['Workbench'],
        summary: 'What an agent was given, what it read, what it concluded and the limits it works within',
        description: 'For judging an agent’s output: its inputs, every tool call and result in order, its answer, and the warrant it ran under. Needs agents:read, or access to the referral the run summarised.',
        params: z.object({ runId: z.uuid() }),
        response: { 200: AgentRunReviewSchema, ...commonErrors },
      },
    },
    async (request) => {
      const { runId } = request.params;
      return withTx(deps.pool, request.ctx, async (tx) => {
        const run = (
          await tx.query<{
            id: string; agent_id: string; agent_version: number; warrant_version: number | null; status: string; requested_by: string; input: unknown; output: unknown;
            turns: number; tool_calls: number; cost_usd: string; name: string;
          }>(`SELECT r.id, r.agent_id, r.agent_version, r.warrant_version, r.status, r.requested_by, r.input, r.output, r.turns, r.tool_calls, r.cost_usd::text, a.name FROM agents.runs r JOIN agents.agents a ON a.id = r.agent_id WHERE r.id = $1`, [runId])
        ).rows[0];
        if (!run) throw notFound('The agent run');
        const mine = run.requested_by === request.ctx.principal.subject;
        const linked = (await tx.query(`SELECT 1 FROM underwriting.referral_summaries WHERE run_id = $1`, [runId])).rowCount! > 0;
        if (!hasPermission(request.ctx.principal, 'agents:read') && !mine && !linked) throw notFound('The agent run');
        const steps = (await tx.query<{ seq: number; at: Date; kind: string; name: string | null; decision: string | null; detail: unknown }>(`SELECT seq, at, kind, name, decision, detail FROM agents.run_steps WHERE run_id = $1 ORDER BY seq`, [runId])).rows;
        const warrant = run.warrant_version
          ? (await tx.query<{ document: { tools?: { name: string; maxCallsPerRun?: number }[]; dataAccess?: string[]; maxModelTurns?: number; maxCostPerRunUsd?: number; escalationRole?: string } }>(`SELECT document FROM agents.warrants WHERE agent_id = $1 AND version = $2`, [run.agent_id, run.warrant_version])).rows[0]?.document
          : undefined;
        const decisions = (await tx.query<{ subject_type: string; subject_id: string; decision: string; reason: string | null; decided_by: string; decided_at: Date }>(`SELECT subject_type, subject_id, decision, reason, decided_by, decided_at FROM agents.output_decisions WHERE run_id = $1 ORDER BY decided_at`, [runId])).rows;
        const answer = (run.output as { answer?: string; text?: string } | null) ?? null;
        return {
          runId: run.id,
          agentId: run.agent_id,
          agentName: run.name,
          agentVersion: run.agent_version,
          status: run.status,
          requestedBy: run.requested_by,
          input: run.input,
          output: run.output,
          evidence: steps.map((s) => ({ seq: s.seq, kind: s.kind, name: s.name, decision: s.decision, detail: s.detail, at: s.at.toISOString() })),
          reasoning: typeof answer?.answer === 'string' ? answer.answer : typeof answer?.text === 'string' ? answer.text : null,
          warrant: warrant
            ? {
                version: run.warrant_version!,
                tools: (warrant.tools ?? []).map((t) => ({ name: t.name, maxCallsPerRun: t.maxCallsPerRun ?? null })),
                dataAccess: warrant.dataAccess ?? [],
                maxModelTurns: warrant.maxModelTurns ?? null,
                maxCostPerRunUsd: warrant.maxCostPerRunUsd ?? null,
                escalationRole: warrant.escalationRole ?? null,
              }
            : null,
          usage: { turns: run.turns, toolCalls: run.tool_calls, costUsd: Number(run.cost_usd) },
          decisions: decisions.map((d) => ({ subjectType: d.subject_type, subjectId: d.subject_id, decision: d.decision, reason: d.reason, decidedBy: d.decided_by, decidedAt: d.decided_at.toISOString() })),
        };
      });
    },
  );

  app.get(
    '/v1/agents/:agentId/output-decisions',
    {
      config: { tenancy: 'platform', permission: 'agents:read' },
      schema: {
        tags: ['Workbench'],
        summary: 'What people decided about an agent’s output: the record evaluation learns from',
        params: z.object({ agentId: z.string().min(1).max(40) }),
        response: {
          200: z.object({
            counts: z.object({ accepted: z.number().int(), edited: z.number().int(), rejected: z.number().int() }),
            items: z.array(z.object({ id: z.uuid(), runId: z.uuid(), subjectType: z.string(), subjectId: z.uuid(), decision: z.string(), reason: z.string().nullable(), original: z.unknown(), edited: z.unknown().nullable(), decidedBy: z.string(), decidedAt: z.iso.datetime() })),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<{ id: string; run_id: string; subject_type: string; subject_id: string; decision: 'accepted' | 'edited' | 'rejected'; reason: string | null; original: unknown; edited: unknown; decided_by: string; decided_at: Date }>(
          `SELECT id, run_id, subject_type, subject_id, decision, reason, original, edited, decided_by, decided_at FROM agents.output_decisions WHERE agent_id = $1 ORDER BY decided_at DESC LIMIT 500`,
          [request.params.agentId],
        ),
      );
      const counts = { accepted: 0, edited: 0, rejected: 0 };
      for (const r of rows) counts[r.decision] += 1;
      return { counts, items: rows.map((r) => ({ id: r.id, runId: r.run_id, subjectType: r.subject_type, subjectId: r.subject_id, decision: r.decision, reason: r.reason, original: r.original, edited: r.edited, decidedBy: r.decided_by, decidedAt: r.decided_at.toISOString() })) };
    },
  );
};
