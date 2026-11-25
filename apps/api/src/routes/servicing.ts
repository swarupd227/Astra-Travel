import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AgentSampleItemSchema, PolicyCancelled, PolicyChanged, ServicingApplyRequestSchema, ServicingPreviewSchema, ServicingRequestSchema, ServicingResultSchema, type PolicySnapshot } from '@astra/contracts';
import { AppError, conflict, publishEvent, withIdempotency, withTx, writeAudit, type RequestContext, type Tx } from '@astra/platform';
import { raiseReview } from '@astra/agents';
import { forbidden } from '@astra/platform';
import { issueNotice } from '../documents/issue';
import { planServicing, type Planned } from '../servicing/engine';
import type { AppDeps } from '../app';
import { commonErrors, idempotencyHeaders, idempotencyKey } from './shared';
import { policyView } from './policies';

/** Previewing and making changes, cancellations and corrections on a policy (E06). Design: docs/adr/0012. */

const params = z.object({ policyId: z.uuid() });

/** What the servicing agent may do on its own: simple changes and cancellations. Everything else is for a person. */
const AGENT_TYPES = ['cancel', 'change_dates', 'change_destinations', 'correct'];

/** Keeps the tables that searches and the duplicate-cover check read in step with the record. */
async function syncTables(tx: Tx, p: Planned, after: PolicySnapshot, accountId: string, policyId: string) {
  await tx.query(`UPDATE policies.policies SET term_start = $2, term_end = $3, premium_total = $4 WHERE id = $1`, [policyId, after.term.start, after.term.end, after.premium.total]);
  if (!p.rewrite) return;
  await tx.query(`DELETE FROM policies.policy_travellers WHERE policy_id = $1`, [policyId]);
  for (const t of after.travellers) {
    await tx.query(`INSERT INTO policies.policy_travellers (policy_id, account_id, traveller_id, first_name, last_name, date_of_birth) VALUES ($1, $2, $3, $4, $5, $6)`, [policyId, accountId, t.id, t.firstName, t.lastName, t.dateOfBirth]);
  }
  await tx.query(`DELETE FROM policies.policy_benefits WHERE policy_id = $1`, [policyId]);
  for (const x of after.benefits) {
    await tx.query(
      `INSERT INTO policies.policy_benefits (policy_id, account_id, code, name, benefit_group, underwriter, limits, premium, coverage_start, coverage_end) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [policyId, accountId, x.code, x.name, x.group, x.underwriter, JSON.stringify(x.limits), x.premium, x.coverageStart, x.coverageEnd],
    );
  }
  await tx.query(`UPDATE underwriting.cover_register SET status = 'cancelled' WHERE policy_ref = $1 AND status = 'active'`, [after.number]);
  const trip = after.trip as { departureDate: string; returnDate: string };
  for (const t of after.travellers) {
    if (!t.dateOfBirth) continue;
    const [start, end] = after.plan.term === 'annual' ? [after.term.start.slice(0, 10), after.term.end.slice(0, 10)] : [trip.departureDate, trip.returnDate];
    await tx.query(`INSERT INTO underwriting.cover_register (first_name, last_name, date_of_birth, policy_ref, trip_start, trip_end, term) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [t.firstName, t.lastName, t.dateOfBirth, after.number, start, end, after.plan.term]);
  }
}

export const servicingRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  const clock = () => deps.now?.() ?? new Date();

  app.post(
    '/v1/policies/:policyId/servicing/preview',
    {
      config: { tenancy: 'account', permission: 'servicing:execute' },
      schema: {
        tags: ['Servicing'],
        summary: 'Preview a change, cancellation or correction without making it (E06-F02-S01)',
        description:
          'Re-rates and re-screens the change with the versions the policy was bound with, and returns what would change, the premium before and after, and what is charged, refunded or kept and why. Nothing is saved. Show it to the person, then send the same request with its `confirmAmount` to make the change.',
        params,
        body: ServicingRequestSchema,
        response: { 200: ServicingPreviewSchema, ...commonErrors },
      },
    },
    async (request) => withTx(deps.pool, request.ctx, async (tx) => (await planServicing(tx, request.ctx, request.params.policyId, request.body, clock(), false)).preview),
  );

  app.post(
    '/v1/policies/:policyId/servicing',
    {
      config: { tenancy: 'account', permission: 'servicing:execute' },
      schema: {
        tags: ['Servicing'],
        summary: 'Make a change, cancellation or correction (E06)',
        description:
          'Needs an Idempotency-Key. The request is worked out again and made only if `confirmAmount` equals what it now costs or refunds, so nobody confirms a price they did not see. The record changes through an event, the notice is issued, and the refund or charge is published for billing.',
        headers: idempotencyHeaders,
        params,
        body: ServicingApplyRequestSchema,
        response: { 200: ServicingResultSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const key = idempotencyKey(request);
      const { request: req, confirmAmount } = request.body;
      const ctx: RequestContext = request.ctx;
      const principal = ctx.principal;

      // The servicing agent acts only within its limits and only on the requester's own confirmation. A request
      // outside them is queued for a person, in a transaction of its own so the queue entry is kept.
      if (principal.kind === 'agent') {
        const agentId = principal.subject.replace(/^agent:/, '');
        const gate = await withTx(deps.pool, ctx, async (tx): Promise<AppError | null> => {
          const run = (await tx.query<{ id: string; input: { question?: string } }>(`SELECT id, input FROM agents.runs WHERE agent_id = $1 AND correlation_id = $2 ORDER BY created_at DESC LIMIT 1`, [agentId, ctx.correlationId])).rows[0];
          if (!run) return forbidden('Servicing is done during an agent run.');
          const said = (run.input.question ?? '').toLowerCase().replace(/\s+/g, ' ');
          const confirmation = (request.body.agentConfirmation ?? '').toLowerCase().replace(/\s+/g, ' ');
          if (!confirmation || !said.includes(confirmation)) return forbidden('The requester has not confirmed this change and its price in their own words. Show them the preview and ask them to confirm.');
          const outside = !AGENT_TYPES.includes(req.type) ? `${req.type.replace(/_/g, ' ')} is not something the servicing agent handles` : Math.abs(Number(confirmAmount)) > deps.config.AGENT_SERVICING_MAX_AMOUNT ? `an amount of ${confirmAmount} is above the agent's limit of ${deps.config.AGENT_SERVICING_MAX_AMOUNT}` : null;
          if (!outside) return null;
          await raiseReview(tx, ctx, { agentId, runId: run.id, kind: 'servicing_request', summary: `Servicing request for policy ${request.params.policyId} for a person: ${outside}.`, detail: { policyId: request.params.policyId, request: req, confirmAmount, reason: outside } });
          return forbidden(`This is outside what the servicing agent may do (${outside}). It has been queued for a person.`);
        });
        if (gate) throw gate;
      }

      const result = await withTx(deps.pool, ctx, async (tx) => {
        const owner = (await tx.query<{ account_id: string }>(`SELECT account_id FROM policies.policies WHERE id = $1`, [request.params.policyId])).rows[0];
        if (!owner) throw new AppError('not_found', 'The policy was not found.');
        return withIdempotency(tx, ctx, { key, method: 'POST', path: `/v1/policies/${request.params.policyId}/servicing`, body: request.body, accountId: owner.account_id }, async () => {
          const planned = await planServicing(tx, ctx, request.params.policyId, req, clock(), true);
          if (!planned.preview.allowed) throw new AppError('precondition_failed', planned.preview.problems.join(' '), planned.preview.problems.map((m) => ({ code: 'not_allowed', field: 'request', message: m })));
          if (planned.preview.confirmAmount !== confirmAmount) throw conflict(`The price has changed: it is now ${planned.preview.confirmAmount}, not ${confirmAmount}. Show the new price and confirm again.`);
          const { policy, before, money } = planned;
          let seq: number;
          if (planned.cancel) {
            seq = Number(
              (
                await tx.query<{ seq: string }>(
                  `INSERT INTO policies.policy_events (policy_id, account_id, type, actor, actor_name, reason, data) VALUES ($1, $2, 'status_changed', $3, $4, $5, $6) RETURNING seq`,
                  [policy.id, policy.accountId, principal.subject, principal.name, req.reason, JSON.stringify({ from: 'active', to: 'cancelled', transaction: 'cancel', noLoss: planned.cancel.noLoss, money })],
                )
              ).rows[0]!.seq,
            );
            await tx.query(`UPDATE policies.policies SET status = 'cancelled' WHERE id = $1`, [policy.id]);
            await tx.query(`UPDATE underwriting.cover_register SET status = 'cancelled' WHERE policy_ref = $1 AND status = 'active'`, [policy.number]);
            await publishEvent(tx, ctx, PolicyCancelled, { policyId: policy.id, number: policy.number, refund: money.refund, basis: money.basis, reason: req.reason }, { accountId: policy.accountId });
          } else {
            seq = Number(
              (
                await tx.query<{ seq: string }>(
                  `INSERT INTO policies.policy_events (policy_id, account_id, type, actor, actor_name, reason, data) VALUES ($1, $2, 'details_changed', $3, $4, $5, $6) RETURNING seq`,
                  [policy.id, policy.accountId, principal.subject, principal.name, req.reason, JSON.stringify({ transaction: req.type, summary: planned.preview.summary, patch: planned.patch, money })],
                )
              ).rows[0]!.seq,
            );
            await syncTables(tx, planned, planned.after!, policy.accountId, policy.id);
            await publishEvent(tx, ctx, PolicyChanged, { policyId: policy.id, number: policy.number, transaction: req.type, premiumTotal: planned.after!.premium.total, charge: money.charge, refund: money.refund }, { accountId: policy.accountId });
          }
          await writeAudit(tx, ctx, {
            action: planned.cancel ? 'policy.cancelled' : 'policy.changed',
            resourceType: 'policy',
            resourceId: policy.id,
            accountId: policy.accountId,
            reason: req.reason,
            data: { number: policy.number, transaction: req.type, premiumBefore: before.premium.total, premiumAfter: planned.after?.premium.total ?? null, charge: money.charge, refund: money.refund, retained: money.retained, basis: money.basis },
          });
          // A correction of names or details is a change like any other; its notice shows exactly what changed.
          const notice = await issueNotice(tx, deps.files, ctx, policy.id, seq);
          return { status: 200, body: { type: req.type, policy: await policyView(tx, policy.id), money: { charge: money.charge, refund: money.refund, retained: money.retained, explanation: money.explanation }, noticeDocumentId: notice.id } };
        });
      });
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(200).send(result.body);
    },
  );

  app.get(
    '/v1/servicing/agent-sample',
    {
      config: { tenancy: 'platform', permission: 'servicing:review' },
      schema: {
        tags: ['Servicing'],
        summary: 'A random sample of the changes the servicing agent made, for review (E06-F04-S01)',
        querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(7), size: z.coerce.number().int().min(1).max(100).default(10) }),
        response: { 200: z.object({ total: z.number().int(), items: z.array(AgentSampleItemSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const since = new Date(clock().getTime() - request.query.days * 86_400_000).toISOString();
        const where = `e.actor LIKE 'agent:%' AND e.type IN ('details_changed', 'status_changed') AND e.occurred_at >= $1`;
        const total = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM policies.policy_events e WHERE ${where}`, [since])).rows[0]!.n);
        const { rows } = await tx.query<{ policy_id: string; number: string; seq: string; occurred_at: Date; actor: string; reason: string | null; data: { transaction?: string; summary?: string; to?: string; money?: { refund?: string; charge?: string } } }>(
          `SELECT e.policy_id, p.number, e.seq, e.occurred_at, e.actor, e.reason, e.data FROM policies.policy_events e JOIN policies.policies p ON p.id = e.policy_id WHERE ${where} ORDER BY random() LIMIT $2`,
          [since, request.query.size],
        );
        return {
          total,
          items: rows.map((r) => ({
            policyId: r.policy_id,
            policyNumber: r.number,
            seq: Number(r.seq),
            occurredAt: r.occurred_at.toISOString(),
            actor: r.actor,
            transaction: r.data.transaction ?? (r.data.to ? 'cancel' : 'change'),
            reason: r.reason,
            summary: r.data.summary ?? null,
            amount: r.data.money ? ((r.data.money.refund ?? '0.00') !== '0.00' ? `refund ${r.data.money.refund}` : (r.data.money.charge ?? '0.00') !== '0.00' ? `charge ${r.data.money.charge}` : null) : null,
          })),
        };
      }),
  );
};
