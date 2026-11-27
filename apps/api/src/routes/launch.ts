import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ReadinessSchema, SIGNOFF_AREAS, SIGNOFF_ROLES, SignoffRequestSchema, type PlanDocument, type Readiness } from '@astra/contracts';
import { AppError, canonicalJson, conflict, forbidden, withTx, writeAudit, type Tx } from '@astra/platform';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';

/** Whether each launch state can be sold, and who has signed for going live (E16-F01-S01, E16-F02-S01). Design: docs/adr/0023. */

type Check = { code: string; passed: boolean; detail: string };
const IN_EFFECT = (alias: string) => `${alias}.effective_from <= $2::date AND (${alias}.effective_to IS NULL OR ${alias}.effective_to > $2::date)`;

/** The checks for one state: its published plans and everything each needs to be quoted, bound, documented and filed. */
async function stateReadiness(tx: Tx, state: string, asOf: string): Promise<Readiness['byState'][number]> {
  const plans = (
    await tx.query<{ id: string; code: string; name: string; version_id: string; version: number; document: PlanDocument; schedule_edition_id: string; policy_edition_id: string | null }>(
      `SELECT p.id, p.code, p.name, v.id AS version_id, v.version, v.document, p.schedule_edition_id, p.policy_edition_id
         FROM plans.plans p JOIN plans.plan_versions v ON v.plan_id = p.id AND v.status = 'published' AND ${IN_EFFECT('v')}
        WHERE p.state = $1 ORDER BY p.code`,
      [state, asOf],
    )
  ).rows;
  const filed = async (type: 'form_edition' | 'rate_manual', ref: { id?: string; code?: string }) =>
    (
      await tx.query(
        `SELECT 1 FROM compliance.filings f WHERE f.state = $1 AND f.item_type = $3 AND f.status = 'approved' AND ${IN_EFFECT('f')}
            AND (($4::uuid IS NOT NULL AND f.item_id = $4) OR ($5::text IS NOT NULL AND f.item_reference = $5))`,
        [state, asOf, type, ref.id ?? null, ref.code ?? null],
      )
    ).rowCount! > 0;

  const out: Readiness['byState'][number]['plans'] = [];
  for (const p of plans) {
    const checks: Check[] = [];
    const rules = (await tx.query(`SELECT 1 FROM underwriting.rule_sets r WHERE r.plan_id = $1 AND r.status = 'published' AND ${IN_EFFECT('r')}`, [p.id, asOf])).rowCount! > 0;
    checks.push({ code: 'eligibility_rules', passed: rules, detail: rules ? 'A published rule set is in effect.' : 'No published rule set is in effect.' });

    const benefits = [...new Set(p.document.benefits.flatMap((b) => (b.ratingBenefit ? [b.ratingBenefit] : [])))].sort();
    for (const benefit of benefits) {
      const m = (
        await tx.query<{ code: string; version: number; total: number | null; passed: number | null }>(
          `SELECT m.code, m.version, run.total, run.passed
             FROM rating.manuals m
             LEFT JOIN LATERAL (SELECT total, passed FROM rating.parity_runs r WHERE r.manual_id = m.id ORDER BY r.ran_at DESC LIMIT 1) run ON true
            WHERE m.state = $1 AND m.benefit = $3 AND m.status = 'published' AND NOT m.illustrative AND ${IN_EFFECT('m')}`,
          [state, asOf, benefit],
        )
      ).rows[0];
      checks.push({ code: `manual_${benefit}`, passed: !!m, detail: m ? `${benefit}: ${m.code} version ${m.version} is published.` : `${benefit}: no published filed manual for ${state}.` });
      if (m) {
        const parity = m.total !== null && m.total > 0 && m.passed === m.total;
        checks.push({ code: `parity_${benefit}`, passed: parity, detail: parity ? `${benefit}: ${m.passed} of ${m.total} parity cases match.` : `${benefit}: the latest parity run does not match every case.` });
        const ok = await filed('rate_manual', { code: m.code });
        checks.push({ code: `manual_filing_${benefit}`, passed: ok, detail: ok ? `${benefit}: ${m.code} is approved in ${state}.` : `${benefit}: no approved filing for ${m.code} in ${state}.` });
      }
    }

    for (const [role, edition] of [['schedule', p.schedule_edition_id], ['policy', p.policy_edition_id]] as const) {
      if (!edition) continue;
      const released = (await tx.query(`SELECT 1 FROM documents.templates WHERE plan_version_id = $1 AND kind = $2 AND status = 'released'`, [p.version_id, role])).rowCount! > 0;
      checks.push({ code: `${role}_template`, passed: released, detail: released ? `The ${role} document template is released.` : `No ${role} document template of this version is released.` });
      const ok = await filed('form_edition', { id: edition });
      checks.push({ code: `${role}_filing`, passed: ok, detail: ok ? `The ${role} form is approved in ${state}.` : `No approved filing for the ${role} form in ${state}.` });
    }
    out.push({ code: p.code, name: p.name, version: p.version, ready: checks.every((c) => c.passed), checks });
  }
  const checks: Check[] = [{ code: 'plan', passed: plans.length > 0, detail: plans.length ? `${plans.length} published plan(s) in effect.` : 'No published plan is in effect for this state.' }];
  return { state, ready: checks.every((c) => c.passed) && out.every((p) => p.ready), checks, plans: out };
}

async function readiness(tx: Tx, requested: string[], asOf: string): Promise<Readiness> {
  const states = requested.length
    ? [...new Set(requested)].sort()
    : (await tx.query<{ state: string }>(`SELECT DISTINCT state::text AS state FROM plans.plans WHERE state IS NOT NULL ORDER BY 1`)).rows.map((r) => r.state);
  const byState = [];
  for (const s of states) byState.push(await stateReadiness(tx, s, asOf));
  // The date is left out, so that a sign-off stands from one day to the next while nothing else changes.
  const reportHash = createHash('sha256').update(canonicalJson({ states, byState })).digest('hex');
  const latest = (
    await tx.query<{ area: (typeof SIGNOFF_AREAS)[number]; decision: 'signed' | 'withdrawn'; note: string; signed_by: string; signed_name: string | null; signed_at: Date }>(
      `SELECT DISTINCT ON (area) area, decision, note, signed_by, signed_name, signed_at FROM launch.signoffs WHERE report_hash = $1 ORDER BY area, signed_at DESC, id DESC`,
      [reportHash],
    )
  ).rows;
  const signoffs = SIGNOFF_AREAS.map((area) => {
    const r = latest.find((x) => x.area === area);
    const signed = r?.decision === 'signed';
    return { area, signed, by: signed ? r.signed_by : null, name: signed ? r.signed_name : null, at: signed ? r.signed_at.toISOString() : null, note: r?.note ?? null };
  });
  const ready = states.length > 0 && byState.every((s) => s.ready);
  const people = new Set(signoffs.flatMap((s) => (s.by ? [s.by] : [])));
  return { states, asOf, ready, reportHash, byState, signoffs, goLiveApproved: ready && people.size === SIGNOFF_AREAS.length };
}

export const launchRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  const today = () => (deps.now?.() ?? new Date()).toISOString().slice(0, 10);

  app.get(
    '/v1/launch-readiness',
    {
      config: { tenancy: 'platform', permission: 'launch:read' },
      schema: {
        tags: ['Launch'],
        summary: 'What each state still needs before it can be sold, and who has signed for going live',
        description: 'For each state: a published plan in effect with its eligibility rules, a published filed manual with matching parity and an approved filing for every rated benefit, and released document templates with approved form filings. Without states, every state that has a plan.',
        querystring: z.object({ states: z.string().regex(/^[A-Z]{2}(,[A-Z]{2}){0,59}$/).optional() }),
        response: { 200: ReadinessSchema, ...commonErrors },
      },
    },
    async (request) => withTx(deps.pool, request.ctx, (tx) => readiness(tx, request.query.states?.split(',') ?? [], today())),
  );

  app.post(
    '/v1/launch-readiness/signoffs',
    {
      config: { tenancy: 'platform', permission: 'launch:signoff' },
      schema: {
        tags: ['Launch'],
        summary: 'Sign, or withdraw a signature, for one area of the readiness report as read (a person only)',
        description: 'Each area is signed by its role: product manager, rating analyst (actuarial), compliance officer and finance analyst, four different people. A report with a state that is not ready cannot be signed.',
        body: SignoffRequestSchema,
        response: { 200: ReadinessSchema, ...commonErrors },
      },
    },
    async (request) => {
      const p = request.ctx.principal;
      const b = request.body;
      if (p.kind !== 'user') throw forbidden('Going live is signed by people.');
      if (!p.roles.includes(SIGNOFF_ROLES[b.area])) throw forbidden(`The ${b.area} sign-off is given by the ${SIGNOFF_ROLES[b.area].replace(/_/g, ' ')} role.`);
      return withTx(deps.pool, request.ctx, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('astra:launch-signoff'))`);
        const report = await readiness(tx, b.states, today());
        if (report.reportHash !== b.reportHash) throw conflict('The readiness report has changed since you read it. Read it again before signing.');
        if (b.decision === 'signed') {
          if (!report.ready) throw new AppError('precondition_failed', `Not every state is ready: ${report.byState.filter((s) => !s.ready).map((s) => s.state).join(', ')}.`);
          const other = report.signoffs.find((s) => s.area !== b.area && s.by === p.subject);
          if (other) throw conflict(`You have signed for ${other.area}; another person signs for ${b.area}.`);
        }
        await tx.query(
          `INSERT INTO launch.signoffs (area, decision, states, report_hash, report, note, signed_by, signed_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [b.area, b.decision, report.states, report.reportHash, JSON.stringify(report.byState), b.note, p.subject, p.name],
        );
        await writeAudit(tx, request.ctx, { action: `launch.${b.decision}`, resourceType: 'launch_signoff', resourceId: report.reportHash, reason: b.note, data: { area: b.area, states: report.states } });
        return readiness(tx, b.states, today());
      });
    },
  );
};
