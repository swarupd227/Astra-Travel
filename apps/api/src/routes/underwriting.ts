import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  DeclarationRequestSchema,
  DeclarationSchema,
  EvaluationInputSchema,
  EvaluationResultSchema,
  ReferralDecided,
  ReferralSchema,
  RuleSetDocumentSchema,
  RuleSetPublished,
  RuleSetSchema,
  RuleTestCaseSchema,
  RuleTestRunSchema,
  SanctionsListSchema,
  type EvaluationResult,
  type Referral,
  type RuleSet,
  type RuleTestRun,
} from '@astra/contracts';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  preconditionFailed,
  publishEvent,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import { checkExpectation, checkRuleSet, evaluate, parseSdn } from '@astra/underwriting';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';
import { assemble, catalogueDocument, planOf, planVersionOf, sha, type RuleSetRow } from './underwriting-data';
import { runEvaluation } from './underwriting-evaluate';
import { recalculate } from '../billing/records';

/** Underwriting and eligibility rules (E03). Design: docs/adr/0008. */

const ruleSetParams = z.object({ ruleSetId: z.uuid() });
const planParams = z.object({ planId: z.uuid() });

async function findRuleSet(tx: Tx, id: string, lock = false): Promise<RuleSetRow> {
  const r = (await tx.query<RuleSetRow>(`SELECT * FROM underwriting.rule_sets WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!r) throw notFound('The rule set');
  return r;
}

/** Document problems: shape checks plus benefits that time conditions name must exist in the plan's catalogue. */
async function problemsOf(tx: Tx, rs: RuleSetRow) {
  const problems = checkRuleSet(rs.document);
  const plan = await planOf(tx, rs.plan_id);
  const cur = (
    await tx.query<{ catalogue_id: string }>(
      `SELECT catalogue_id FROM plans.plan_versions WHERE plan_id = $1 ORDER BY version DESC LIMIT 1`,
      [plan.id],
    )
  ).rows[0];
  if (cur) {
    const cat = await catalogueDocument(tx, cur.catalogue_id);
    for (const b of rs.document.timeBasedBenefits) {
      if (!cat.benefits.some((x) => x.code === b.benefit)) problems.push({ path: `timeBasedBenefits.${b.benefit}`, message: `The catalogue has no benefit ${b.benefit}.` });
    }
  }
  return problems;
}

async function toRuleSet(tx: Tx, r: RuleSetRow): Promise<RuleSet> {
  return {
    id: r.id,
    planId: r.plan_id,
    version: r.version,
    status: r.status,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    document: r.document,
    problems: r.status === 'draft' ? await problemsOf(tx, r) : [],
    contributors: r.contributors,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    approvedBy: r.approved_by,
    approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
    publishedBy: r.published_by,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
  };
}

interface CaseRow {
  id: string;
  name: string;
  input: z.infer<typeof RuleTestCaseSchema>['input'];
  expected: z.infer<typeof RuleTestCaseSchema>['expected'];
  existing_covers: z.infer<typeof RuleTestCaseSchema>['existingCovers'] | null;
}

const casesFor = async (tx: Tx, planId: string) =>
  (await tx.query<CaseRow>(`SELECT id, name, input, expected, existing_covers FROM underwriting.test_cases WHERE plan_id = $1 ORDER BY name`, [planId])).rows;

const toCase = (c: CaseRow) => ({ id: c.id, name: c.name, input: c.input, expected: c.expected, ...(c.existing_covers ? { existingCovers: c.existing_covers } : {}) });

/** A run is current only for the same cases and the same rule set content. */
const runHash = (cases: CaseRow[], rs: RuleSetRow) =>
  sha({ document: rs.document, cases: cases.map((c) => ({ id: c.id, input: c.input, expected: c.expected, covers: c.existing_covers })) });

async function runCases(tx: Tx, rs: RuleSetRow, cases: CaseRow[]): Promise<RuleTestRun['results']> {
  const out: RuleTestRun['results'] = [];
  // Test cases are evaluated against the plan's current version.
  const pv = (
    await tx.query<{ id: string }>(`SELECT id FROM plans.plan_versions WHERE plan_id = $1 ORDER BY (status = 'published') DESC, version DESC LIMIT 1`, [rs.plan_id])
  ).rows[0];
  if (!pv) throw preconditionFailed('The plan has no version to test against.');
  const planVersion = await planVersionOf(tx, pv.id);
  for (const c of cases) {
    try {
      const data = await assemble(tx, planVersion, rs, c.input, true, c.existing_covers ?? []);
      const misses = checkExpectation(c.expected, evaluate(c.input, data));
      out.push({ caseId: c.id, name: c.name, passed: misses.length === 0, message: misses.length ? `Differs: ${misses.join('; ')}.` : 'As expected.' });
    } catch (err) {
      if (err instanceof AppError) out.push({ caseId: c.id, name: c.name, passed: false, message: `Not evaluated: ${err.message}` });
      else throw err;
    }
  }
  return out;
}

async function readiness(tx: Tx, rs: RuleSetRow) {
  const checks: { check: 'approved' | 'tests' | 'values'; passed: boolean; detail: string }[] = [];
  checks.push({ check: 'approved', passed: rs.status === 'approved' || rs.status === 'published', detail: rs.status === 'draft' ? 'Waiting for approval by a second person.' : `Approved by ${rs.approved_by}.` });
  const problems = await problemsOf(tx, rs);
  checks.push({ check: 'values', passed: problems.length === 0, detail: problems.length ? problems.map((p) => p.message).join(' ') : 'The rule set has no problems.' });
  const cases = await casesFor(tx, rs.plan_id);
  const run = (
    await tx.query<{ total: number; passed: number; cases_hash: string }>(
      `SELECT total, passed, cases_hash FROM underwriting.test_runs WHERE rule_set_id = $1 ORDER BY ran_at DESC LIMIT 1`,
      [rs.id],
    )
  ).rows[0];
  let tests: { passed: boolean; detail: string };
  if (!cases.length) tests = { passed: false, detail: 'Add at least one test case for this plan.' };
  else if (!run) tests = { passed: false, detail: `${cases.length} test cases have not been run against this version.` };
  else if (run.cases_hash !== runHash(cases, rs)) tests = { passed: false, detail: 'The test cases or the rule set changed since the last run; run them again.' };
  else tests = { passed: run.passed === run.total, detail: `${run.passed} of ${run.total} test cases pass.` };
  checks.push({ check: 'tests', ...tests });
  return { ready: checks.every((c) => c.passed), checks };
}

interface ReferralRow {
  id: string;
  case_ref: string;
  kind: 'underwriting' | 'sanctions';
  stage: 'quote' | 'bind' | 'change' | 'refund';
  status: 'open' | 'approved' | 'declined';
  recommendation: 'refer' | 'recommend_decline';
  rule_set_id: string;
  plan_version_id: string;
  summary: string;
  evaluation: EvaluationResult;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}
const toReferral = (r: ReferralRow): Referral => ({
  id: r.id,
  caseRef: r.case_ref,
  kind: r.kind,
  stage: r.stage,
  status: r.status,
  recommendation: r.recommendation,
  ruleSetId: r.rule_set_id,
  planVersionId: r.plan_version_id,
  summary: r.summary,
  evaluation: r.evaluation,
  createdAt: r.created_at.toISOString(),
  decidedBy: r.decided_by,
  decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  decisionReason: r.decision_reason,
});

const normaliseText = (t: string) => t.replace(/\s+/g, ' ').trim();

export const underwritingRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // ---------------- Rule sets ----------------

  app.get(
    '/v1/plans/:planId/rule-sets',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Rule set versions of a plan, newest first',
        params: planParams,
        response: { 200: z.object({ items: z.array(RuleSetSchema.omit({ document: true, problems: true })) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await planOf(tx, request.params.planId);
        const { rows } = await tx.query<RuleSetRow>(`SELECT * FROM underwriting.rule_sets WHERE plan_id = $1 ORDER BY version DESC`, [request.params.planId]);
        return {
          items: rows.map((r) => {
            return {
              id: r.id,
              planId: r.plan_id,
              version: r.version,
              status: r.status,
              effectiveFrom: r.effective_from,
              effectiveTo: r.effective_to,
              contributors: r.contributors,
              createdAt: r.created_at.toISOString(),
              updatedAt: r.updated_at.toISOString(),
              approvedBy: r.approved_by,
              approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
              publishedBy: r.published_by,
              publishedAt: r.published_at ? r.published_at.toISOString() : null,
            };
          }),
        };
      }),
  );

  app.post(
    '/v1/plans/:planId/rule-sets',
    {
      config: { tenancy: 'platform', permission: 'underwriting:manage' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Start a draft rule set for a state or account plan (a copy of the latest version, if there is one)',
        params: planParams,
        body: z.object({ effectiveFrom: z.iso.date() }),
        response: { 201: RuleSetSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const row = await withTx(deps.pool, request.ctx, async (tx) => {
        const plan = await planOf(tx, request.params.planId);
        if (plan.kind === 'base') throw new AppError('validation_failed', 'Rule sets belong to state and account plans.');
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('ruleset:' || $1))`, [plan.id]);
        if ((await tx.query(`SELECT 1 FROM underwriting.rule_sets WHERE plan_id = $1 AND status = 'draft'`, [plan.id])).rowCount) {
          throw conflict('This plan already has a draft rule set. Continue that one.');
        }
        const last = (await tx.query<RuleSetRow>(`SELECT * FROM underwriting.rule_sets WHERE plan_id = $1 ORDER BY version DESC LIMIT 1`, [plan.id])).rows[0];
        const document = last ? last.document : RuleSetDocumentSchema.parse({});
        const r = (
          await tx.query<RuleSetRow>(
            `INSERT INTO underwriting.rule_sets (plan_id, version, effective_from, document, contributors, created_by)
             VALUES ($1, $2, $3, $4, ARRAY[$5], $5) RETURNING *`,
            [plan.id, (last?.version ?? 0) + 1, request.body.effectiveFrom, JSON.stringify(document), request.ctx.principal.subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, { action: 'rule_set.drafted', resourceType: 'plan', resourceId: plan.id, data: { code: plan.code, version: r.version } });
        return toRuleSet(tx, r);
      });
      return reply.code(201).send(row);
    },
  );

  app.get(
    '/v1/rule-sets/:ruleSetId',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: { tags: ['Underwriting'], summary: 'A rule set version', params: ruleSetParams, response: { 200: RuleSetSchema, ...commonErrors } },
    },
    async (request) => withTx(deps.pool, request.ctx, async (tx) => toRuleSet(tx, await findRuleSet(tx, request.params.ruleSetId))),
  );

  app.put(
    '/v1/rule-sets/:ruleSetId',
    {
      config: { tenancy: 'platform', permission: 'underwriting:manage' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Save a draft rule set; problems are returned and block approval',
        params: ruleSetParams,
        body: z.object({ document: RuleSetDocumentSchema, effectiveFrom: z.iso.date().optional() }),
        response: { 200: RuleSetSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const rs = await findRuleSet(tx, request.params.ruleSetId, true);
        if (rs.status !== 'draft') throw conflict(`Version ${rs.version} is ${rs.status} and cannot change. Start a new draft.`);
        const subject = request.ctx.principal.subject;
        const row = (
          await tx.query<RuleSetRow>(
            `UPDATE underwriting.rule_sets SET document = $2, effective_from = $3, updated_at = now(),
                    contributors = CASE WHEN $4 = ANY (contributors) THEN contributors ELSE contributors || $4 END
              WHERE id = $1 RETURNING *`,
            [rs.id, JSON.stringify(request.body.document), request.body.effectiveFrom ?? rs.effective_from, subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, { action: 'rule_set.edited', resourceType: 'plan', resourceId: rs.plan_id, data: { version: rs.version } });
        return toRuleSet(tx, row);
      }),
  );

  app.delete(
    '/v1/rule-sets/:ruleSetId',
    {
      config: { tenancy: 'platform', permission: 'underwriting:manage' },
      schema: { tags: ['Underwriting'], summary: 'Discard a draft rule set', params: ruleSetParams, response: { 204: z.null(), ...commonErrors } },
    },
    async (request, reply) => {
      await withTx(deps.pool, request.ctx, async (tx) => {
        const rs = await findRuleSet(tx, request.params.ruleSetId, true);
        if (rs.status !== 'draft') throw conflict(`Version ${rs.version} is ${rs.status} and cannot be discarded.`);
        await tx.query(`DELETE FROM underwriting.rule_sets WHERE id = $1`, [rs.id]);
        await writeAudit(tx, request.ctx, { action: 'rule_set.discarded', resourceType: 'plan', resourceId: rs.plan_id, data: { version: rs.version } });
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/rule-sets/:ruleSetId/approve',
    {
      config: { tenancy: 'platform', permission: 'underwriting:approve' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Approve a draft rule set built by someone else',
        params: ruleSetParams,
        body: z.object({ note: z.string().trim().min(5).max(500) }),
        response: { 200: RuleSetSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const rs = await findRuleSet(tx, request.params.ruleSetId, true);
        if (rs.status !== 'draft') throw conflict(`Version ${rs.version} is already ${rs.status}.`);
        const subject = request.ctx.principal.subject;
        if (rs.contributors.includes(subject)) throw forbidden('A rule set must be approved by someone who did not build or edit it.');
        const problems = await problemsOf(tx, rs);
        if (problems.length) {
          throw new AppError('validation_failed', `${problems.length} problem${problems.length === 1 ? '' : 's'}: the draft is not complete.`, problems.map((p) => ({ code: 'rule_set', field: p.path, message: p.message })));
        }
        const hash = sha({ document: rs.document, effectiveFrom: rs.effective_from });
        const row = (
          await tx.query<RuleSetRow>(
            `UPDATE underwriting.rule_sets SET status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3, sha256 = $4 WHERE id = $1 RETURNING *`,
            [rs.id, subject, request.body.note, hash],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, { action: 'rule_set.approved', resourceType: 'plan', resourceId: rs.plan_id, reason: request.body.note, data: { version: rs.version, sha256: hash } });
        return toRuleSet(tx, row);
      }),
  );

  app.get(
    '/v1/rule-sets/:ruleSetId/readiness',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: {
        tags: ['Underwriting'],
        summary: 'What stands between this rule set and publication: approval, no problems, every test passing',
        params: ruleSetParams,
        response: {
          200: z.object({ ready: z.boolean(), checks: z.array(z.object({ check: z.enum(['approved', 'tests', 'values']), passed: z.boolean(), detail: z.string() })) }),
          ...commonErrors,
        },
      },
    },
    async (request) => withTx(deps.pool, request.ctx, async (tx) => readiness(tx, await findRuleSet(tx, request.params.ruleSetId))),
  );

  app.post(
    '/v1/rule-sets/:ruleSetId/publish',
    {
      config: { tenancy: 'platform', permission: 'underwriting:approve' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Publish an approved rule set; every test case must pass on its current content (E03-F05-S02)',
        params: ruleSetParams,
        response: { 200: RuleSetSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const rs = await findRuleSet(tx, request.params.ruleSetId, true);
        if (rs.status !== 'approved') throw conflict(`Only an approved rule set can be published; this one is ${rs.status}.`);
        const r = await readiness(tx, rs);
        const failed = r.checks.filter((c) => !c.passed);
        if (failed.length) {
          throw new AppError('precondition_failed', `Not published: ${failed.map((c) => c.detail).join(' ')}`, failed.map((c) => ({ code: c.check, field: c.check, message: c.detail })));
        }
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('ruleset:' || $1))`, [rs.plan_id]);
        await tx.query(
          `UPDATE underwriting.rule_sets SET effective_to = $3
            WHERE plan_id = $1 AND status = 'published' AND id <> $2 AND effective_from < $3 AND (effective_to IS NULL OR effective_to > $3)`,
          [rs.plan_id, rs.id, rs.effective_from],
        );
        let row: RuleSetRow;
        try {
          row = (
            await tx.query<RuleSetRow>(`UPDATE underwriting.rule_sets SET status = 'published', published_by = $2, published_at = now() WHERE id = $1 RETURNING *`, [rs.id, request.ctx.principal.subject])
          ).rows[0]!;
        } catch (err) {
          if ((err as { code?: string }).code === '23P01') throw conflict(`Another published rule set already covers ${rs.effective_from}.`);
          throw err;
        }
        await publishEvent(tx, request.ctx, RuleSetPublished, { ruleSetId: row.id, planId: row.plan_id, version: row.version, effectiveFrom: row.effective_from }, { accountId: null });
        await writeAudit(tx, request.ctx, { action: 'rule_set.published', resourceType: 'plan', resourceId: rs.plan_id, data: { version: rs.version, checks: r.checks } });
        return toRuleSet(tx, row);
      }),
  );

  // ---------------- Test cases ----------------

  app.get(
    '/v1/plans/:planId/rule-test-cases',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: { tags: ['Underwriting'], summary: 'Rule test cases for this plan', params: planParams, response: { 200: z.object({ items: z.array(RuleTestCaseSchema) }), ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await planOf(tx, request.params.planId);
        return { items: (await casesFor(tx, request.params.planId)).map(toCase) };
      }),
  );

  app.post(
    '/v1/plans/:planId/rule-test-cases',
    {
      config: { tenancy: 'platform', permission: 'underwriting:manage' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Add or replace a rule test case: an evaluation input and the outcome expected',
        params: planParams,
        body: RuleTestCaseSchema.omit({ id: true }),
        response: { 201: RuleTestCaseSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const c = await withTx(deps.pool, request.ctx, async (tx) => {
        const plan = await planOf(tx, request.params.planId);
        if (plan.kind === 'base') throw new AppError('validation_failed', 'Add test cases to a state or account plan.');
        const b = request.body;
        const row = (
          await tx.query<CaseRow>(
            `INSERT INTO underwriting.test_cases (plan_id, name, input, expected, existing_covers, created_by) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (plan_id, name) DO UPDATE SET input = EXCLUDED.input, expected = EXCLUDED.expected, existing_covers = EXCLUDED.existing_covers
             RETURNING id, name, input, expected, existing_covers`,
            [plan.id, b.name, JSON.stringify(b.input), JSON.stringify(b.expected), b.existingCovers ? JSON.stringify(b.existingCovers) : null, request.ctx.principal.subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, { action: 'rule_test_case.saved', resourceType: 'plan', resourceId: plan.id, data: { name: b.name, expected: b.expected } });
        return toCase(row);
      });
      return reply.code(201).send(c);
    },
  );

  app.delete(
    '/v1/plans/:planId/rule-test-cases/:caseId',
    {
      config: { tenancy: 'platform', permission: 'underwriting:manage' },
      schema: { tags: ['Underwriting'], summary: 'Remove a rule test case', params: planParams.extend({ caseId: z.uuid() }), response: { 204: z.null(), ...commonErrors } },
    },
    async (request, reply) => {
      await withTx(deps.pool, request.ctx, async (tx) => {
        const r = await tx.query<{ name: string }>(`DELETE FROM underwriting.test_cases WHERE id = $1 AND plan_id = $2 RETURNING name`, [request.params.caseId, request.params.planId]);
        if (!r.rows[0]) throw notFound('The test case');
        await writeAudit(tx, request.ctx, { action: 'rule_test_case.removed', resourceType: 'plan', resourceId: request.params.planId, data: { name: r.rows[0].name } });
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/rule-sets/:ruleSetId/test-runs',
    {
      config: { tenancy: 'platform', permission: 'underwriting:manage' },
      schema: { tags: ['Underwriting'], summary: 'Evaluate every test case with this rule set', params: ruleSetParams, response: { 201: RuleTestRunSchema, ...commonErrors } },
    },
    async (request, reply) => {
      const run = await withTx(deps.pool, request.ctx, async (tx) => {
        const rs = await findRuleSet(tx, request.params.ruleSetId);
        const cases = await casesFor(tx, rs.plan_id);
        if (!cases.length) throw preconditionFailed('There are no test cases for this plan yet.');
        const results = await runCases(tx, rs, cases);
        const passed = results.filter((r) => r.passed).length;
        const ranAt = (
          await tx.query<{ ran_at: Date }>(
            `INSERT INTO underwriting.test_runs (rule_set_id, ran_by, total, passed, cases_hash, results) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ran_at`,
            [rs.id, request.ctx.principal.subject, results.length, passed, runHash(cases, rs), JSON.stringify(results)],
          )
        ).rows[0]!.ran_at;
        await writeAudit(tx, request.ctx, { action: 'rule_tests.run', resourceType: 'plan', resourceId: rs.plan_id, data: { version: rs.version, total: results.length, passed } });
        return { ruleSetId: rs.id, ranAt: ranAt.toISOString(), total: results.length, passed, results };
      });
      return reply.code(201).send(run);
    },
  );

  app.get(
    '/v1/rule-sets/:ruleSetId/test-runs/latest',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: { tags: ['Underwriting'], summary: 'The latest test run of this rule set', params: ruleSetParams, response: { 200: RuleTestRunSchema, ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{ rule_set_id: string; ran_at: Date; total: number; passed: number; results: RuleTestRun['results'] }>(
            `SELECT rule_set_id, ran_at, total, passed, results FROM underwriting.test_runs WHERE rule_set_id = $1 ORDER BY ran_at DESC LIMIT 1`,
            [request.params.ruleSetId],
          )
        ).rows[0];
        if (!r) throw notFound('A test run');
        return { ruleSetId: r.rule_set_id, ranAt: r.ran_at.toISOString(), total: r.total, passed: r.passed, results: r.results };
      }),
  );

  // ---------------- Sanctions lists ----------------

  app.get(
    '/v1/sanctions-lists',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: { tags: ['Underwriting'], summary: 'Sanctions list versions, newest first', response: { 200: z.object({ items: z.array(SanctionsListSchema) }), ...commonErrors } },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<{ id: string; source: string; published_on: string | null; status: 'draft' | 'approved' | 'rejected' | 'superseded'; entries: number; aliases: number; sha256: string; loaded_by: string; loaded_at: Date; decided_by: string | null; decided_at: Date | null }>(
          `SELECT id, source, published_on::text, status, entries, aliases, sha256, loaded_by, loaded_at, decided_by, decided_at FROM underwriting.sanctions_lists ORDER BY loaded_at DESC LIMIT 100`,
        ),
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          source: r.source,
          publishedOn: r.published_on,
          status: r.status,
          entries: r.entries,
          aliases: r.aliases,
          sha256: r.sha256,
          loadedBy: r.loaded_by,
          loadedAt: r.loaded_at.toISOString(),
          decidedBy: r.decided_by,
          decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
        })),
      };
    },
  );

  app.post(
    '/v1/sanctions-lists',
    {
      config: { tenancy: 'platform', permission: 'underwriting:manage' },
      bodyLimit: 40 * 1024 * 1024,
      schema: {
        tags: ['Underwriting'],
        summary: 'Load the OFAC SDN list from its published SDN.CSV (and ALT.CSV for aliases); a second person approves it',
        body: z.object({
          source: z.string().trim().min(3).max(300),
          publishedOn: z.iso.date().optional(),
          sdnCsv: z.string().min(10),
          altCsv: z.string().optional(),
        }),
        response: { 201: SanctionsListSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const parsed = parseSdn(b.sdnCsv, b.altCsv);
      if (parsed.problems.length) {
        throw new AppError('validation_failed', `${parsed.problems.length} problem${parsed.problems.length === 1 ? '' : 's'} in the file; nothing was loaded.`, parsed.problems.slice(0, 100).map((m) => ({ code: 'sanctions_file', field: 'sdnCsv', message: m })));
      }
      if (parsed.entries.length === 0) throw new AppError('validation_failed', 'The file has no individuals to screen against.');
      const hash = createHash('sha256').update(b.sdnCsv).update('\u0000').update(b.altCsv ?? '').digest('hex');
      const row = await withTx(deps.pool, request.ctx, async (tx) => {
        let list: { id: string; loaded_at: Date };
        try {
          list = (
            await tx.query<{ id: string; loaded_at: Date }>(
              `INSERT INTO underwriting.sanctions_lists (source, published_on, entries, aliases, sha256, loaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, loaded_at`,
              [b.source, b.publishedOn ?? null, parsed.entries.length, parsed.aliases, hash, request.ctx.principal.subject],
            )
          ).rows[0]!;
        } catch (err) {
          if ((err as { constraint?: string }).constraint === 'sanctions_lists_sha256_key') throw conflict('This exact list has already been loaded.');
          throw err;
        }
        for (let i = 0; i < parsed.entries.length; i += 2000) {
          const chunk = parsed.entries.slice(i, i + 2000);
          await tx.query(
            `INSERT INTO underwriting.sanctions_entries (list_id, uid, name, program, aliases, births)
             SELECT $1, e.uid, e.name, e.program, ARRAY(SELECT jsonb_array_elements_text(e.aliases)), e.births
               FROM jsonb_to_recordset($2::jsonb) AS e(uid text, name text, program text, aliases jsonb, births jsonb)`,
            [list.id, JSON.stringify(chunk)],
          );
        }
        await writeAudit(tx, request.ctx, { action: 'sanctions_list.loaded', resourceType: 'sanctions_list', resourceId: list.id, data: { source: b.source, entries: parsed.entries.length, aliases: parsed.aliases, sha256: hash } });
        return {
          id: list.id,
          source: b.source,
          publishedOn: b.publishedOn ?? null,
          status: 'draft' as const,
          entries: parsed.entries.length,
          aliases: parsed.aliases,
          sha256: hash,
          loadedBy: request.ctx.principal.subject,
          loadedAt: list.loaded_at.toISOString(),
          decidedBy: null,
          decidedAt: null,
        };
      });
      return reply.code(201).send(row);
    },
  );

  app.post(
    '/v1/sanctions-lists/:listId/decision',
    {
      config: { tenancy: 'platform', permission: 'underwriting:approve' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Approve or reject a loaded list (not by the person who loaded it); approving replaces the list in use',
        params: z.object({ listId: z.uuid() }),
        body: z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(5).max(500) }),
        response: { 200: z.object({ id: z.uuid(), status: z.enum(['approved', 'rejected']) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const l = (await tx.query<{ status: string; loaded_by: string }>(`SELECT status, loaded_by FROM underwriting.sanctions_lists WHERE id = $1 FOR UPDATE`, [request.params.listId])).rows[0];
        if (!l) throw notFound('The sanctions list');
        if (l.status !== 'draft') throw conflict(`This list is already ${l.status}.`);
        const subject = request.ctx.principal.subject;
        if (l.loaded_by === subject) throw forbidden('A sanctions list must be approved by someone other than the person who loaded it.');
        const status = request.body.decision === 'approve' ? ('approved' as const) : ('rejected' as const);
        if (status === 'approved') await tx.query(`UPDATE underwriting.sanctions_lists SET status = 'superseded' WHERE status = 'approved'`);
        await tx.query(`UPDATE underwriting.sanctions_lists SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1`, [request.params.listId, status, subject, request.body.reason]);
        await writeAudit(tx, request.ctx, { action: `sanctions_list.${status}`, resourceType: 'sanctions_list', resourceId: request.params.listId, reason: request.body.reason, data: {} });
        return { id: request.params.listId, status };
      }),
  );

  // ---------------- Evaluation ----------------

  app.post(
    '/v1/underwriting/evaluate',
    {
      config: { tenancy: 'platform', permission: 'underwriting:evaluate' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Decide eligibility at quote, bind or change (E03)',
        description:
          'Uses the rule set published for the plan on the decision date, or the one named in ruleSetId as a labelled preview. Returns every check with its result: plan limits, prohibited destinations, sanctions screening, duplicate cover, referral rules, the pre-existing waiver and CFAR eligibility. With persist, a referred or held case is stored as a referral for an underwriter (needs caseRef); evaluating the same case again returns the open referral.',
        body: z.object({
          planVersionId: z.uuid(),
          ruleSetId: z.uuid().optional(),
          input: EvaluationInputSchema,
          persist: z.boolean().default(false),
          caseRef: z.string().trim().min(1).max(100).optional(),
        }),
        response: { 200: EvaluationResultSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, (tx) => runEvaluation(tx, request.ctx, request.body)),  );

  // ---------------- Referrals ----------------

  app.get(
    '/v1/referrals',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Referrals and sanctions holds, oldest open first',
        querystring: z.object({ status: z.enum(['open', 'approved', 'declined']).optional(), kind: z.enum(['underwriting', 'sanctions']).optional() }),
        response: { 200: z.object({ items: z.array(ReferralSchema.omit({ evaluation: true })) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<ReferralRow>(
          `SELECT * FROM underwriting.referrals WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2)
            ORDER BY (status = 'open') DESC, created_at ASC LIMIT 200`,
          [request.query.status ?? null, request.query.kind ?? null],
        ),
      );
      return {
        items: rows.map((r) => {
          const { evaluation: _e, ...rest } = toReferral(r);
          return rest;
        }),
      };
    },
  );

  app.get(
    '/v1/referrals/:referralId',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: { tags: ['Underwriting'], summary: 'A referral with its evaluation', params: z.object({ referralId: z.uuid() }), response: { 200: ReferralSchema, ...commonErrors } },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = (await tx.query<ReferralRow>(`SELECT * FROM underwriting.referrals WHERE id = $1`, [request.params.referralId])).rows[0];
        if (!r) throw notFound('The referral');
        return toReferral(r);
      }),
  );

  app.post(
    '/v1/referrals/:referralId/decision',
    {
      config: { tenancy: 'platform', permission: 'referrals:decide' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Decide a referral: approve (for a sanctions hold, clear the match) or decline, with a reason. Declines are always a person’s decision.',
        params: z.object({ referralId: z.uuid() }),
        body: z.object({ decision: z.enum(['approved', 'declined']), reason: z.string().trim().min(5).max(1000) }),
        response: { 200: ReferralSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const cur = (await tx.query<ReferralRow>(`SELECT * FROM underwriting.referrals WHERE id = $1 FOR UPDATE`, [request.params.referralId])).rows[0];
        if (!cur) throw notFound('The referral');
        if (cur.status !== 'open') throw conflict(`This referral is already ${cur.status}.`);
        if (request.ctx.principal.kind !== 'user') throw forbidden('A referral is decided by a person.');
        const r = (
          await tx.query<ReferralRow>(
            `UPDATE underwriting.referrals SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1 RETURNING *`,
            [cur.id, request.body.decision, request.ctx.principal.subject, request.body.reason],
          )
        ).rows[0]!;
        // The decision and the reason go back to the channel that raised the case: the case reference of a quote or
        // bind referral is the quote's id, and its account is the channel's.
        // A hold on a change or refund names the policy as the second part of its case reference.
        const channel = (
          await tx.query<{ account_id: string }>(`SELECT account_id FROM policies.quotes WHERE id::text = $1 UNION ALL SELECT account_id FROM policies.policies WHERE id::text = split_part($1, ':', 2) LIMIT 1`, [r.case_ref])
        ).rows[0];
        // A cleared refund hold releases the refund records it was holding.
        if (r.stage === 'refund' && request.body.decision === 'approved') {
          const policyId = r.case_ref.split(':')[1]!;
          const held = (await tx.query<{ id: string }>(`SELECT id FROM billing.premium_records WHERE policy_id = $1 AND status = 'held' AND premium_cents < 0`, [policyId])).rows;
          for (const h of held) await recalculate(tx, h.id);
        }
        await publishEvent(tx, request.ctx, ReferralDecided, { referralId: r.id, caseRef: r.case_ref, decision: request.body.decision, reason: request.body.reason }, { accountId: channel?.account_id ?? null });
        await writeAudit(tx, request.ctx, { action: `referral.${request.body.decision}`, resourceType: 'referral', resourceId: r.id, reason: request.body.reason, data: { caseRef: r.case_ref, kind: r.kind } });
        return toReferral(r);
      }),
  );

  // ---------------- Declarations ----------------

  app.post(
    '/v1/underwriting/declarations',
    {
      config: { tenancy: 'platform', permission: 'underwriting:evaluate' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Record the able-to-travel confirmation with the filed notice text (E03-F01-S01)',
        body: DeclarationRequestSchema,
        response: { 201: DeclarationSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const row = await withTx(deps.pool, request.ctx, async (tx) => {
        const pv = await planVersionOf(tx, b.planVersionId);
        const plan = await planOf(tx, pv.plan_id);
        const editionId = plan.policy_edition_id ?? plan.schedule_edition_id;
        const ed = (await tx.query<{ text: string; form_number: string; edition: string }>(`SELECT text, form_number, edition FROM studio.form_editions WHERE id = $1`, [editionId])).rows[0];
        if (!ed) throw notFound('The form edition');
        const text = normaliseText(b.noticeText);
        if (!normaliseText(ed.text).includes(text)) {
          throw new AppError('validation_failed', `The notice text is not in ${ed.form_number} (${ed.edition}), the form this plan uses. The confirmation must carry the filed wording.`, [
            { code: 'notice_text', field: 'noticeText', message: 'Not the filed wording' },
          ]);
        }
        const hash = createHash('sha256').update(text).digest('hex');
        const r = (
          await tx.query<{ id: string; recorded_at: Date }>(
            `INSERT INTO underwriting.declarations (plan_version_id, subject_ref, confirmed, notice_text, form_edition_id, text_sha256, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, recorded_at`,
            [pv.id, b.subjectRef, b.confirmed, text, editionId, hash, request.ctx.principal.subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, { action: 'declaration.recorded', resourceType: 'declaration', resourceId: r.id, data: { subjectRef: b.subjectRef, confirmed: b.confirmed, planVersionId: pv.id, form: `${ed.form_number} ${ed.edition}`, textSha256: hash } });
        return {
          id: r.id,
          planVersionId: pv.id,
          subjectRef: b.subjectRef,
          confirmed: b.confirmed,
          noticeText: text,
          formEditionId: editionId,
          formReference: `${ed.form_number} ed. ${ed.edition}`,
          textSha256: hash,
          recordedBy: request.ctx.principal.subject,
          recordedAt: r.recorded_at.toISOString(),
        };
      });
      return reply.code(201).send(row);
    },
  );

  app.get(
    '/v1/underwriting/declarations',
    {
      config: { tenancy: 'platform', permission: 'underwriting:read' },
      schema: {
        tags: ['Underwriting'],
        summary: 'Confirmations recorded for a quote or traveller, newest first',
        querystring: z.object({ subjectRef: z.string().trim().min(1).max(100) }),
        response: { 200: z.object({ items: z.array(DeclarationSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<{ id: string; plan_version_id: string; subject_ref: string; confirmed: boolean; notice_text: string; form_edition_id: string; form_number: string; edition: string; text_sha256: string; recorded_by: string; recorded_at: Date }>(
          `SELECT d.*, e.form_number, e.edition FROM underwriting.declarations d JOIN studio.form_editions e ON e.id = d.form_edition_id
            WHERE d.subject_ref = $1 ORDER BY d.recorded_at DESC LIMIT 100`,
          [request.query.subjectRef],
        ),
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          planVersionId: r.plan_version_id,
          subjectRef: r.subject_ref,
          confirmed: r.confirmed,
          noticeText: r.notice_text,
          formEditionId: r.form_edition_id,
          formReference: `${r.form_number} ed. ${r.edition}`,
          textSha256: r.text_sha256,
          recordedBy: r.recorded_by,
          recordedAt: r.recorded_at.toISOString(),
        })),
      };
    },
  );
};
