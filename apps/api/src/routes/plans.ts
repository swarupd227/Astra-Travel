import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  CatalogueDocumentSchema,
  CreatePlanRequestSchema,
  PlanDiffSchema,
  PlanDocumentSchema,
  PlanSchema,
  PlanTestCaseSchema,
  PlanTestRunSchema,
  PlanVersionPublished,
  PlanVersionSchema,
  PublishCheckSchema,
  type CatalogueDocument,
  type ManualDocument,
  type Plan,
  type PlanDocument,
  type PlanTestCase,
  type PlanTestRun,
  type PlanVersion,
  type VariableType,
} from '@astra/contracts';
import {
  AppError,
  canonicalJson,
  conflict,
  forbidden,
  notFound,
  preconditionFailed,
  publishEvent,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import {
  diffPlans,
  planToQuote,
  requiredValues,
  validatePlan,
  type PlanVariables,
} from '@astra/plans';
import { QuoteRatingError, rateQuote, RatingError } from '@astra/rating';
import { approvalFor } from '@astra/studio';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';

/** Plan builder and publishing (E01-F03, E01-F04, E10-F01-S02). Design: docs/adr/0007. */

interface PlanRow {
  id: string;
  code: string;
  name: string;
  kind: Plan['kind'];
  term: Plan['term'];
  parent_plan_id: string | null;
  state: string | null;
  account_id: string | null;
  schedule_edition_id: string;
  policy_edition_id: string | null;
  created_by: string;
  created_at: Date;
}

interface VersionRow {
  id: string;
  plan_id: string;
  version: number;
  status: PlanVersion['status'];
  effective_from: string;
  effective_to: string | null;
  catalogue_id: string;
  document: PlanDocument;
  links: Record<string, string>;
  sha256: string | null;
  contributors: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  published_by: string | null;
  published_at: Date | null;
}

interface CaseRow {
  id: string;
  name: string;
  input: PlanTestCase['input'];
  expected: PlanTestCase['expected'];
}

type Check = z.infer<typeof PublishCheckSchema>;

const planParams = z.object({ planId: z.uuid() });
const versionParams = z.object({ versionId: z.uuid() });
const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

async function findPlan(tx: Tx, id: string): Promise<PlanRow> {
  const r = (await tx.query<PlanRow>(`SELECT * FROM plans.plans WHERE id = $1`, [id])).rows[0];
  if (!r) throw notFound('The plan');
  return r;
}

async function findVersion(tx: Tx, id: string, lock = false): Promise<VersionRow> {
  const r = (
    await tx.query<VersionRow>(
      `SELECT * FROM plans.plan_versions WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
  if (!r) throw notFound('The plan version');
  return r;
}

/** The version a new draft or a derived plan starts from: published first, then approved. */
async function currentVersion(tx: Tx, planId: string): Promise<VersionRow | null> {
  return (
    (
      await tx.query<VersionRow>(
        `SELECT * FROM plans.plan_versions WHERE plan_id = $1 AND status IN ('published', 'approved')
          ORDER BY (status = 'published') DESC, version DESC LIMIT 1`,
        [planId],
      )
    ).rows[0] ?? null
  );
}

async function catalogueFor(
  tx: Tx,
  id: string,
): Promise<{
  id: string;
  status: string;
  version: number;
  document: CatalogueDocument;
  schedule_edition_id: string;
  policy_edition_id: string | null;
}> {
  const c = (
    await tx.query<{
      id: string;
      status: string;
      version: number;
      document: CatalogueDocument;
      schedule_edition_id: string;
      policy_edition_id: string | null;
    }>(
      `SELECT id, status, version, document, schedule_edition_id, policy_edition_id FROM studio.benefit_catalogues WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!c) throw notFound('The benefit catalogue');
  return c;
}

/** Variables of the approved maps of the plan's schedule and policy editions. */
export async function variablesFor(
  tx: Tx,
  scheduleEditionId: string,
  policyEditionId: string | null,
): Promise<PlanVariables> {
  const { rows } = await tx.query<{
    source: string;
    key: string;
    label: string;
    type: VariableType;
    constraints: Record<string, unknown>;
  }>(
    `SELECT CASE WHEN m.edition_id = $1 THEN 'schedule' ELSE 'policy' END AS source, v.key, v.label, v.type, v.constraints
       FROM studio.variable_maps m JOIN studio.form_variables v ON v.map_id = m.id
      WHERE m.status = 'approved' AND (m.edition_id = $1 OR m.edition_id = $2)`,
    [scheduleEditionId, policyEditionId],
  );
  return new Map(
    rows.map((r) => [
      `${r.source}:${r.key}`,
      { label: r.label, type: r.type, constraints: r.constraints },
    ]),
  );
}

/** The plan a version is checked against: account plans keep their state plan's structure, within the base plan's bounds. */
async function parentFor(
  tx: Tx,
  plan: PlanRow,
): Promise<{ document: PlanDocument; kind: Plan['kind'] } | null> {
  if (plan.kind !== 'account' || !plan.parent_plan_id) return null;
  const statePlan = await findPlan(tx, plan.parent_plan_id);
  const stateVersion = await currentVersion(tx, statePlan.id);
  if (!stateVersion) return null;
  const base = statePlan.parent_plan_id ? await currentVersion(tx, statePlan.parent_plan_id) : null;
  return {
    kind: 'state',
    document: { ...stateVersion.document, bounds: base?.document.bounds ?? {} },
  };
}

async function problemsOf(tx: Tx, plan: PlanRow, v: VersionRow) {
  const cat = await catalogueFor(tx, v.catalogue_id);
  const vars = await variablesFor(tx, plan.schedule_edition_id, plan.policy_edition_id);
  const problems = validatePlan(
    v.document,
    cat.document,
    vars,
    await parentFor(tx, plan),
    plan.kind,
  );
  if (plan.term !== 'annual' && v.document.settings.some((s) => s.setting === 'annual_term')) {
    problems.push({
      path: 'settings.annual_term',
      message: 'The annual term applies only to annual plans.',
    });
  }
  return problems;
}

async function toVersion(tx: Tx, plan: PlanRow, v: VersionRow): Promise<PlanVersion> {
  return {
    id: v.id,
    planId: v.plan_id,
    version: v.version,
    status: v.status,
    effectiveFrom: v.effective_from,
    effectiveTo: v.effective_to,
    catalogueId: v.catalogue_id,
    document: v.document,
    // Approved versions were checked when approved; drafts are checked against today's maps.
    problems: v.status === 'draft' ? await problemsOf(tx, plan, v) : [],
    contributors: v.contributors,
    createdAt: v.created_at.toISOString(),
    updatedAt: v.updated_at.toISOString(),
    approvedBy: v.approved_by,
    approvedAt: v.approved_at ? v.approved_at.toISOString() : null,
    publishedBy: v.published_by,
    publishedAt: v.published_at ? v.published_at.toISOString() : null,
  };
}

async function toPlan(tx: Tx, p: PlanRow): Promise<Plan> {
  const current = await currentVersion(tx, p.id);
  const draft = (
    await tx.query<{ id: string; version: number }>(
      `SELECT id, version FROM plans.plan_versions WHERE plan_id = $1 AND status = 'draft'`,
      [p.id],
    )
  ).rows[0];
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    kind: p.kind,
    term: p.term,
    parentPlanId: p.parent_plan_id,
    state: p.state,
    accountId: p.account_id,
    scheduleEditionId: p.schedule_edition_id,
    policyEditionId: p.policy_edition_id,
    createdBy: p.created_by,
    createdAt: p.created_at.toISOString(),
    current: current
      ? {
          id: current.id,
          version: current.version,
          status: current.status,
          effectiveFrom: current.effective_from,
        }
      : null,
    draft: draft ? { id: draft.id, version: draft.version } : null,
  };
}

interface ManualRow {
  id: string;
  code: string;
  version: number;
  benefit: string;
  state: string;
  illustrative: boolean;
  document: ManualDocument;
}

async function publishedManual(
  tx: Tx,
  state: string,
  benefit: string,
  date: string,
): Promise<ManualRow | null> {
  return (
    (
      await tx.query<ManualRow>(
        `SELECT id, code, version, benefit, state, illustrative, document FROM rating.manuals
          WHERE state = $1 AND benefit = $2 AND status = 'published'
            AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to > $3::date)`,
        [state, benefit, date],
      )
    ).rows[0] ?? null
  );
}

async function casesFor(tx: Tx, planId: string): Promise<CaseRow[]> {
  return (
    await tx.query<CaseRow>(
      `SELECT id, name, input, expected FROM plans.test_cases WHERE plan_id = $1 ORDER BY name`,
      [planId],
    )
  ).rows;
}

/** A run is current only for the same cases and the same version content. */
const runHash = (cases: CaseRow[], v: VersionRow) =>
  sha({
    document: v.document,
    effectiveFrom: v.effective_from,
    cases: cases.map((c) => ({ id: c.id, input: c.input, expected: c.expected })),
  });

async function runCases(
  tx: Tx,
  plan: PlanRow,
  v: VersionRow,
  cases: CaseRow[],
): Promise<PlanTestRun['results']> {
  const cat = await catalogueFor(tx, v.catalogue_id);
  const results: PlanTestRun['results'] = [];
  for (const c of cases) {
    const q = planToQuote(v.document, cat.document, plan.state!, c.input);
    try {
      const manuals = new Map<string, ManualRow>();
      for (const b of q.benefits) {
        const m = await publishedManual(tx, plan.state!, b.benefit, q.rateDate);
        if (m) manuals.set(b.benefit, m);
      }
      const r = rateQuote(q, (benefit) => {
        const m = manuals.get(benefit);
        if (!m)
          throw new RatingError(
            `No published ${benefit} manual is in effect in ${plan.state} on ${q.rateDate}.`,
          );
        return m;
      });
      const perBenefit = Object.fromEntries(r.perBenefit.map((b) => [b.benefit, b.total]));
      const misses: string[] = [];
      if (c.expected.policyTotal !== undefined && c.expected.policyTotal !== r.policyTotal) {
        misses.push(`policy total ${r.policyTotal}, expected ${c.expected.policyTotal}`);
      }
      for (const [b, want] of Object.entries(c.expected.perBenefit ?? {})) {
        if (perBenefit[b] !== want)
          misses.push(`${b} ${perBenefit[b] ?? 'not rated'}, expected ${want}`);
      }
      if (r.notRated.length)
        misses.push(...r.notRated.map((n) => `${n.benefit} not rated: ${n.reasons.join(' ')}`));
      results.push({
        caseId: c.id,
        name: c.name,
        passed: misses.length === 0,
        message: misses.length ? `Differs: ${misses.join('; ')}.` : 'Matches to the cent.',
        actual: { policyTotal: r.policyTotal, perBenefit },
      });
    } catch (err) {
      const message =
        err instanceof QuoteRatingError
          ? err.problems.map((p) => p.message).join(' ')
          : err instanceof RatingError
            ? err.message
            : null;
      if (message === null) throw err;
      results.push({
        caseId: c.id,
        name: c.name,
        passed: false,
        message: `Not rated: ${message}`,
        actual: null,
      });
    }
  }
  return results;
}

/** Everything that stands between an approved version and publication (ADR 0007), with the links it would publish with. */
async function readiness(
  tx: Tx,
  plan: PlanRow,
  v: VersionRow,
): Promise<{ ready: boolean; checks: Check[]; links: Record<string, string> }> {
  const checks: Check[] = [];
  const links: Record<string, string> = {};
  const date = v.effective_from;
  checks.push({
    check: 'approved',
    passed: v.status === 'approved' || v.status === 'published',
    detail:
      v.status === 'draft'
        ? 'Waiting for approval by a second person.'
        : `Approved by ${v.approved_by}.`,
  });
  const cat = await catalogueFor(tx, v.catalogue_id);
  checks.push({
    check: 'catalogue',
    passed: cat.status === 'approved',
    detail:
      cat.status === 'approved'
        ? `Benefit catalogue version ${cat.version} is approved.`
        : `Benefit catalogue version ${cat.version} is ${cat.status}; start a new draft on the current catalogue.`,
  });
  if (plan.kind === 'base') {
    checks.push({
      check: 'forms_filed',
      passed: false,
      detail: 'Base plans are templates: publish a state or account plan made from it.',
    });
    return { ready: false, checks, links };
  }
  const state = plan.state!;
  const editions = (
    await tx.query<{ id: string; form_number: string; edition: string; kind: string }>(
      `SELECT id, form_number, edition, kind FROM studio.form_editions WHERE id = $1 OR id = $2`,
      [plan.schedule_edition_id, plan.policy_edition_id],
    )
  ).rows;
  const formDetails: string[] = [];
  let formsOk = true;
  for (const e of editions) {
    const a = await approvalFor(tx, { itemType: 'form_edition', itemId: e.id }, state, date);
    formsOk &&= a.approved;
    formDetails.push(`${e.form_number} (${e.edition}): ${a.reason}`);
    links[e.id === plan.schedule_edition_id ? 'schedule' : 'policy'] =
      `${e.form_number} ed. ${e.edition}`;
  }
  checks.push({ check: 'forms_filed', passed: formsOk, detail: formDetails.join(' ') });

  const rated = [
    ...new Set(v.document.benefits.map((b) => b.ratingBenefit).filter((b): b is string => !!b)),
  ];
  const missing: string[] = [];
  for (const b of rated) {
    const m = await publishedManual(tx, state, b, date);
    if (m) links[b] = `${m.code} v${m.version}`;
    else missing.push(b);
  }
  checks.push({
    check: 'manuals',
    passed: missing.length === 0,
    detail: missing.length
      ? `No published ${missing.join(', ')} manual in effect in ${state} on ${date}.`
      : rated.length
        ? `Rated with ${rated.map((b) => links[b]).join(', ')}.`
        : 'No benefit is rated on its own.',
  });

  const problems = await problemsOf(tx, plan, v);
  checks.push({
    check: 'values',
    passed: problems.length === 0,
    detail: problems.length
      ? problems.map((p) => p.message).join(' ')
      : 'Every value is within its filed range.',
  });

  const cases = await casesFor(tx, plan.id);
  const run = (
    await tx.query<{ total: number; passed: number; cases_hash: string }>(
      `SELECT total, passed, cases_hash FROM plans.test_runs WHERE version_id = $1 ORDER BY ran_at DESC LIMIT 1`,
      [v.id],
    )
  ).rows[0];
  let tests: { passed: boolean; detail: string };
  if (!cases.length)
    tests = {
      passed: rated.length === 0,
      detail: rated.length
        ? 'Add at least one rating test case for this plan.'
        : 'No rated benefits to test.',
    };
  else if (!run)
    tests = {
      passed: false,
      detail: `${cases.length} test cases have not been run against this version.`,
    };
  else if (run.cases_hash !== runHash(cases, v))
    tests = { passed: false, detail: 'The test cases changed since the last run; run them again.' };
  else
    tests = {
      passed: run.passed === run.total,
      detail: `${run.passed} of ${run.total} test cases pass.`,
    };
  checks.push({ check: 'tests', ...tests });
  return { ready: checks.every((c) => c.passed), checks, links };
}

function refuseProblems(problems: { path: string; message: string }[], what: string) {
  if (problems.length) {
    throw new AppError(
      'validation_failed',
      problems.length === 1 ? problems[0]!.message : `${problems.length} problems: ${what}.`,
      problems.slice(0, 100).map((p) => ({ code: 'plan', field: p.path, message: p.message })),
    );
  }
}

export const planRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    '/v1/plans',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary: 'List plans with their current version and draft',
        querystring: z.object({
          kind: z.enum(['base', 'state', 'account']).optional(),
          state: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
          parentPlanId: z.uuid().optional(),
        }),
        response: { 200: z.object({ items: z.array(PlanSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const q = request.query;
        const { rows } = await tx.query<PlanRow>(
          `SELECT * FROM plans.plans WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR state = $2)
              AND ($3::uuid IS NULL OR parent_plan_id = $3) ORDER BY kind, code LIMIT 500`,
          [q.kind ?? null, q.state ?? null, q.parentPlanId ?? null],
        );
        const items: Plan[] = [];
        for (const r of rows) items.push(await toPlan(tx, r));
        return { items };
      }),
  );

  app.post(
    '/v1/plans',
    {
      config: { tenancy: 'platform', permission: 'plans:manage' },
      schema: {
        tags: ['Plans'],
        summary:
          'Create a base plan from an approved catalogue, a state variant of a base plan, or an account plan from a published state plan',
        body: CreatePlanRequestSchema,
        response: {
          201: z.object({ plan: PlanSchema, draft: PlanVersionSchema }),
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const subject = request.ctx.principal.subject;
      const result = await withTx(deps.pool, request.ctx, async (tx) => {
        if ((await tx.query(`SELECT 1 FROM plans.plans WHERE code = $1`, [b.code])).rowCount) {
          throw conflict(`A plan with code ${b.code} already exists.`);
        }
        let catalogueId: string;
        let document: PlanDocument;
        let term: Plan['term'];
        let state: string | null = null;
        let accountId: string | null = null;
        let parentId: string | null = null;
        if (b.kind === 'base') {
          const cat = await catalogueFor(tx, b.catalogueId);
          if (cat.status !== 'approved')
            throw preconditionFailed(
              `Catalogue version ${cat.version} is ${cat.status}; plans are built from the approved catalogue.`,
            );
          catalogueId = cat.id;
          document = PlanDocumentSchema.parse({});
          term = b.term;
        } else {
          const parent = await findPlan(tx, b.parentPlanId);
          const wanted = b.kind === 'state' ? 'base' : 'state';
          if (parent.kind !== wanted)
            throw new AppError(
              'validation_failed',
              `A ${b.kind} plan is made from a ${wanted} plan.`,
            );
          const from = await currentVersion(tx, parent.id);
          if (!from || (b.kind === 'account' && from.status !== 'published')) {
            throw preconditionFailed(
              b.kind === 'state'
                ? `${parent.code} has no approved version yet.`
                : `${parent.code} has no published version yet.`,
            );
          }
          catalogueId = from.catalogue_id;
          // Bounds belong to the base plan; state and account plans carry none of their own.
          document = { ...from.document, bounds: {} };
          term = parent.term;
          parentId = parent.id;
          if (b.kind === 'state') state = b.state;
          else {
            state = parent.state;
            if (
              !(await tx.query(`SELECT 1 FROM platform.accounts WHERE id = $1`, [b.accountId]))
                .rowCount
            )
              throw notFound('The account');
            accountId = b.accountId;
          }
        }
        const cat = await catalogueFor(tx, catalogueId);
        const plan = (
          await tx.query<PlanRow>(
            `INSERT INTO plans.plans (code, name, kind, term, parent_plan_id, state, account_id, schedule_edition_id, policy_edition_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [
              b.code,
              b.name,
              b.kind,
              term,
              parentId,
              state,
              accountId,
              cat.schedule_edition_id,
              cat.policy_edition_id,
              subject,
            ],
          )
        ).rows[0]!;
        const v = (
          await tx.query<VersionRow>(
            `INSERT INTO plans.plan_versions (plan_id, version, effective_from, catalogue_id, document, contributors, created_by)
             VALUES ($1, 1, $2, $3, $4, ARRAY[$5], $5) RETURNING *`,
            [plan.id, b.effectiveFrom, catalogueId, JSON.stringify(document), subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'plan.created',
          resourceType: 'plan',
          resourceId: plan.id,
          data: { code: plan.code, kind: plan.kind, state, accountId, parentPlanId: parentId },
        });
        return { plan: await toPlan(tx, plan), draft: await toVersion(tx, plan, v) };
      });
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/v1/plans/:planId',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary: 'A plan and its versions, newest first',
        params: planParams,
        response: {
          200: z.object({
            plan: PlanSchema,
            versions: z.array(PlanVersionSchema.omit({ document: true, problems: true })),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const p = await findPlan(tx, request.params.planId);
        const { rows } = await tx.query<VersionRow>(
          `SELECT * FROM plans.plan_versions WHERE plan_id = $1 ORDER BY version DESC`,
          [p.id],
        );
        return {
          plan: await toPlan(tx, p),
          versions: rows.map(toVersionSync),
        };
      }),
  );

  app.post(
    '/v1/plans/:planId/drafts',
    {
      config: { tenancy: 'platform', permission: 'plans:manage' },
      schema: {
        tags: ['Plans'],
        summary: 'Start a new draft version: a copy of the current version',
        params: planParams,
        body: z.object({ effectiveFrom: z.iso.date() }),
        response: { 201: PlanVersionSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const v = await withTx(deps.pool, request.ctx, async (tx) => {
        const p = await findPlan(tx, request.params.planId);
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('plan:' || $1))`, [p.id]);
        if (
          (
            await tx.query(
              `SELECT 1 FROM plans.plan_versions WHERE plan_id = $1 AND status = 'draft'`,
              [p.id],
            )
          ).rowCount
        ) {
          throw conflict('This plan already has a draft. Continue that one.');
        }
        const from = await currentVersion(tx, p.id);
        if (!from) throw preconditionFailed('This plan has no approved version to copy.');
        // A new draft moves to the current approved catalogue for the schedule, if there is a newer one.
        const cat = (
          await tx.query<{ id: string }>(
            `SELECT id FROM studio.benefit_catalogues WHERE schedule_edition_id = $1 AND status = 'approved'`,
            [p.schedule_edition_id],
          )
        ).rows[0];
        const next = (
          await tx.query<{ n: number }>(
            `SELECT max(version) + 1 AS n FROM plans.plan_versions WHERE plan_id = $1`,
            [p.id],
          )
        ).rows[0]!.n;
        const row = (
          await tx.query<VersionRow>(
            `INSERT INTO plans.plan_versions (plan_id, version, effective_from, catalogue_id, document, contributors, created_by)
             VALUES ($1, $2, $3, $4, $5, ARRAY[$6], $6) RETURNING *`,
            [
              p.id,
              next,
              request.body.effectiveFrom,
              cat?.id ?? from.catalogue_id,
              JSON.stringify(from.document),
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'plan_version.drafted',
          resourceType: 'plan',
          resourceId: p.id,
          data: { version: row.version, copiedFrom: from.version },
        });
        return toVersion(tx, p, row);
      });
      return reply.code(201).send(v);
    },
  );

  app.get(
    '/v1/plan-versions/:versionId',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary:
          'A plan version with its document; drafts list their problems against the current variable maps',
        params: versionParams,
        response: { 200: PlanVersionSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.versionId);
        return toVersion(tx, await findPlan(tx, v.plan_id), v);
      }),
  );

  app.put(
    '/v1/plan-versions/:versionId',
    {
      config: { tenancy: 'platform', permission: 'plans:manage' },
      schema: {
        tags: ['Plans'],
        summary:
          'Save a draft (the problems are returned; a draft with problems cannot be approved)',
        description:
          'A value outside its filed range is refused at once, with the range in the message; other problems (missing values, upgrades not offered) are listed for the builder to finish.',
        params: versionParams,
        body: z.object({ document: PlanDocumentSchema, effectiveFrom: z.iso.date().optional() }),
        response: { 200: PlanVersionSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.versionId, true);
        if (v.status !== 'draft')
          throw conflict(
            `Version ${v.version} is ${v.status} and cannot change. Start a new draft.`,
          );
        const p = await findPlan(tx, v.plan_id);
        const next = {
          ...v,
          document: request.body.document,
          effective_from: request.body.effectiveFrom ?? v.effective_from,
        };
        const problems = await problemsOf(tx, p, next);
        // Values outside the filed range or the base plan's bounds are refused as they are entered (E01-F03-S01, S04).
        refuseProblems(
          problems.filter((x) =>
            /filed range|for account plans|is fixed by the base plan|must be one of|not in the approved variable maps/.test(
              x.message,
            ),
          ),
          'values outside what is filed or allowed',
        );
        const subject = request.ctx.principal.subject;
        const row = (
          await tx.query<VersionRow>(
            `UPDATE plans.plan_versions SET document = $2, effective_from = $3, updated_at = now(),
                    contributors = CASE WHEN $4 = ANY (contributors) THEN contributors ELSE contributors || $4 END
              WHERE id = $1 RETURNING *`,
            [v.id, JSON.stringify(request.body.document), next.effective_from, subject],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'plan_version.edited',
          resourceType: 'plan',
          resourceId: p.id,
          data: {
            version: v.version,
            changes: diffPlans(asDiffable(v), asDiffable(row)).changes.length,
          },
        });
        return toVersion(tx, p, row);
      }),
  );

  app.delete(
    '/v1/plan-versions/:versionId',
    {
      config: { tenancy: 'platform', permission: 'plans:manage' },
      schema: {
        tags: ['Plans'],
        summary: 'Discard a draft version',
        params: versionParams,
        response: { 204: z.null(), ...commonErrors },
      },
    },
    async (request, reply) => {
      await withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.versionId, true);
        if (v.status !== 'draft')
          throw conflict(`Version ${v.version} is ${v.status} and cannot be discarded.`);
        if (v.version === 1)
          throw conflict('The first version of a plan cannot be discarded; edit it instead.');
        await tx.query(`DELETE FROM plans.test_runs WHERE version_id = $1`, [v.id]);
        await tx.query(`DELETE FROM plans.plan_versions WHERE id = $1`, [v.id]);
        await writeAudit(tx, request.ctx, {
          action: 'plan_version.discarded',
          resourceType: 'plan',
          resourceId: v.plan_id,
          data: { version: v.version },
        });
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/plan-versions/:versionId/approve',
    {
      config: { tenancy: 'platform', permission: 'plans:approve' },
      schema: {
        tags: ['Plans'],
        summary:
          'Approve a draft built by someone else (E01-F04-S01); a draft with problems cannot be approved',
        params: versionParams,
        body: z.object({ note: z.string().trim().min(5).max(500) }),
        response: { 200: PlanVersionSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.versionId, true);
        if (v.status !== 'draft') throw conflict(`Version ${v.version} is already ${v.status}.`);
        const subject = request.ctx.principal.subject;
        if (v.contributors.includes(subject)) {
          throw forbidden(
            'A plan version must be approved by someone who did not build or edit it.',
          );
        }
        const p = await findPlan(tx, v.plan_id);
        refuseProblems(await problemsOf(tx, p, v), 'the draft is not complete');
        const hash = sha({
          document: v.document,
          effectiveFrom: v.effective_from,
          catalogueId: v.catalogue_id,
        });
        const row = (
          await tx.query<VersionRow>(
            `UPDATE plans.plan_versions SET status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3, sha256 = $4
              WHERE id = $1 RETURNING *`,
            [v.id, subject, request.body.note, hash],
          )
        ).rows[0]!;
        // A base plan has no publication: its approved version replaces the previous approved one.
        await writeAudit(tx, request.ctx, {
          action: 'plan_version.approved',
          resourceType: 'plan',
          resourceId: p.id,
          reason: request.body.note,
          data: { code: p.code, version: v.version, sha256: hash },
        });
        return toVersion(tx, p, row);
      }),
  );

  app.get(
    '/v1/plan-versions/:versionId/readiness',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary:
          'What stands between this version and publication: approval, catalogue, filed forms, rate manuals, values and tests',
        params: versionParams,
        response: {
          200: z.object({
            ready: z.boolean(),
            checks: z.array(PublishCheckSchema),
            links: z.record(z.string(), z.string()),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.versionId);
        return readiness(tx, await findPlan(tx, v.plan_id), v);
      }),
  );

  app.post(
    '/v1/plan-versions/:versionId/publish',
    {
      config: { tenancy: 'platform', permission: 'plans:approve' },
      schema: {
        tags: ['Plans'],
        summary:
          'Publish an approved state or account plan version; every check must pass (E10-F01-S02)',
        params: versionParams,
        response: { 200: PlanVersionSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.versionId, true);
        const p = await findPlan(tx, v.plan_id);
        if (v.status !== 'approved')
          throw conflict(`Only an approved version can be published; this one is ${v.status}.`);
        const r = await readiness(tx, p, v);
        const failed = r.checks.filter((c) => !c.passed);
        if (failed.length) {
          throw new AppError(
            'precondition_failed',
            `Not published: ${failed.map((c) => c.detail).join(' ')}`,
            failed.map((c) => ({ code: c.check, field: c.check, message: c.detail })),
          );
        }
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('plan:' || $1))`, [p.id]);
        // The version it replaces stops on the day this one starts.
        await tx.query(
          `UPDATE plans.plan_versions SET effective_to = $3
            WHERE plan_id = $1 AND status = 'published' AND id <> $2
              AND effective_from < $3 AND (effective_to IS NULL OR effective_to > $3)`,
          [p.id, v.id, v.effective_from],
        );
        let row: VersionRow;
        try {
          row = (
            await tx.query<VersionRow>(
              `UPDATE plans.plan_versions SET status = 'published', published_by = $2, published_at = now(), links = $3
                WHERE id = $1 RETURNING *`,
              [v.id, request.ctx.principal.subject, JSON.stringify(r.links)],
            )
          ).rows[0]!;
        } catch (err) {
          if ((err as { code?: string }).code === '23P01') {
            throw conflict(
              `Another published version of ${p.code} already covers ${v.effective_from}.`,
            );
          }
          throw err;
        }
        await publishEvent(
          tx,
          request.ctx,
          PlanVersionPublished,
          {
            planId: p.id,
            versionId: row.id,
            code: p.code,
            version: row.version,
            state: p.state,
            accountId: p.account_id,
            effectiveFrom: row.effective_from,
          },
          { accountId: p.account_id },
        );
        await writeAudit(tx, request.ctx, {
          action: 'plan_version.published',
          resourceType: 'plan',
          resourceId: p.id,
          data: { code: p.code, version: row.version, links: r.links, checks: r.checks },
        });
        return toVersion(tx, p, row);
      }),
  );

  app.get(
    '/v1/plan-versions/:versionId/compare',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary:
          'What changed between two versions of a plan, or between a plan and the plan it comes from (E01-F04-S02)',
        params: versionParams,
        querystring: z.object({ with: z.uuid() }),
        response: { 200: PlanDiffSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        // Versions not yet published are compared with the forms and manuals they would be published with.
        const side = async (id: string) => {
          const v = await findVersion(tx, id);
          if (v.status === 'published' || v.status === 'superseded' || v.status === 'withdrawn')
            return asDiffable(v);
          const plan = await findPlan(tx, v.plan_id);
          return {
            ...asDiffable(v),
            links: plan.kind === 'base' ? {} : (await readiness(tx, plan, v)).links,
          };
        };
        return diffPlans(await side(request.query.with), await side(request.params.versionId));
      }),
  );

  app.get(
    '/v1/plan-catalogues',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary: 'Approved benefit catalogues base plans can be built from',
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.uuid(),
                version: z.number().int(),
                formNumber: z.string(),
                edition: z.string(),
                title: z.string(),
                benefits: z.number().int(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const { rows } = await tx.query<{
          id: string;
          version: number;
          form_number: string;
          edition: string;
          title: string;
          document: CatalogueDocument;
        }>(
          `SELECT c.id, c.version, e.form_number, e.edition, e.title, c.document
             FROM studio.benefit_catalogues c JOIN studio.form_editions e ON e.id = c.schedule_edition_id
            WHERE c.status = 'approved' ORDER BY e.form_number, e.edition`,
        );
        return {
          items: rows.map((r) => ({
            id: r.id,
            version: r.version,
            formNumber: r.form_number,
            edition: r.edition,
            title: r.title,
            benefits: r.document.benefits.length,
          })),
        };
      }),
  );

  app.get(
    '/v1/plan-versions/:versionId/builder',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary:
          'What the builder offers for this version: the catalogue, the filed variables and, for account plans, the bounds',
        params: versionParams,
        response: {
          200: z.object({
            catalogue: CatalogueDocumentSchema,
            catalogueVersion: z.number().int(),
            variables: z.array(
              z.object({
                ref: z.string(),
                label: z.string(),
                type: z.string(),
                constraints: z.record(z.string(), z.unknown()),
              }),
            ),
            required: z.array(z.string()),
            bounds: PlanDocumentSchema.shape.bounds,
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.versionId);
        const plan = await findPlan(tx, v.plan_id);
        const cat = await catalogueFor(tx, v.catalogue_id);
        const vars = await variablesFor(tx, plan.schedule_edition_id, plan.policy_edition_id);
        return {
          catalogue: cat.document,
          catalogueVersion: cat.version,
          variables: [...vars.entries()]
            .map(([ref, x]) => ({ ref, label: x.label, type: x.type, constraints: x.constraints }))
            .sort((a, b) => a.label.localeCompare(b.label)),
          required: requiredValues(v.document, cat.document),
          bounds:
            plan.kind === 'base'
              ? v.document.bounds
              : ((await parentFor(tx, plan))?.document.bounds ?? {}),
        };
      }),
  );

  // ---------------- Test cases (E01-F04-S03) ----------------

  app.get(
    '/v1/plans/:planId/test-cases',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary: 'Rating test cases for this plan',
        params: planParams,
        response: { 200: z.object({ items: z.array(PlanTestCaseSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        await findPlan(tx, request.params.planId);
        return { items: await casesFor(tx, request.params.planId) };
      }),
  );

  app.post(
    '/v1/plans/:planId/test-cases',
    {
      config: { tenancy: 'platform', permission: 'plans:manage' },
      schema: {
        tags: ['Plans'],
        summary: 'Add or replace a rating test case: a quote with the expected totals to the cent',
        params: planParams,
        body: PlanTestCaseSchema.omit({ id: true }).refine(
          (c) =>
            c.expected.policyTotal !== undefined ||
            Object.keys(c.expected.perBenefit ?? {}).length > 0,
          {
            message: 'Give the expected policy total or at least one benefit total.',
            path: ['expected'],
          },
        ),
        response: { 201: PlanTestCaseSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const c = await withTx(deps.pool, request.ctx, async (tx) => {
        const p = await findPlan(tx, request.params.planId);
        if (p.kind === 'base')
          throw new AppError(
            'validation_failed',
            'Base plans are not rated; add test cases to a state or account plan.',
          );
        const b = request.body;
        const row = (
          await tx.query<CaseRow>(
            `INSERT INTO plans.test_cases (plan_id, name, input, expected, created_by) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (plan_id, name) DO UPDATE SET input = EXCLUDED.input, expected = EXCLUDED.expected
             RETURNING id, name, input, expected`,
            [
              p.id,
              b.name,
              JSON.stringify(b.input),
              JSON.stringify(b.expected),
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'plan_test_case.saved',
          resourceType: 'plan',
          resourceId: p.id,
          data: { name: b.name, expected: b.expected },
        });
        return row;
      });
      return reply.code(201).send(c);
    },
  );

  app.delete(
    '/v1/plans/:planId/test-cases/:caseId',
    {
      config: { tenancy: 'platform', permission: 'plans:manage' },
      schema: {
        tags: ['Plans'],
        summary: 'Remove a test case',
        params: planParams.extend({ caseId: z.uuid() }),
        response: { 204: z.null(), ...commonErrors },
      },
    },
    async (request, reply) => {
      await withTx(deps.pool, request.ctx, async (tx) => {
        const r = await tx.query<{ name: string }>(
          `DELETE FROM plans.test_cases WHERE id = $1 AND plan_id = $2 RETURNING name`,
          [request.params.caseId, request.params.planId],
        );
        if (!r.rows[0]) throw notFound('The test case');
        await writeAudit(tx, request.ctx, {
          action: 'plan_test_case.removed',
          resourceType: 'plan',
          resourceId: request.params.planId,
          data: { name: r.rows[0].name },
        });
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/plan-versions/:versionId/test-runs',
    {
      config: { tenancy: 'platform', permission: 'plans:manage' },
      schema: {
        tags: ['Plans'],
        summary:
          'Rate every test case with this version and the published manuals, and compare to the cent',
        params: versionParams,
        response: { 201: PlanTestRunSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const run = await withTx(deps.pool, request.ctx, async (tx) => {
        const v = await findVersion(tx, request.params.versionId);
        const p = await findPlan(tx, v.plan_id);
        if (p.kind === 'base') throw new AppError('validation_failed', 'Base plans are not rated.');
        const cases = await casesFor(tx, p.id);
        if (!cases.length) throw preconditionFailed('There are no test cases for this plan yet.');
        const results = await runCases(tx, p, v, cases);
        const passed = results.filter((r) => r.passed).length;
        const ranAt = (
          await tx.query<{ ran_at: Date }>(
            `INSERT INTO plans.test_runs (version_id, ran_by, total, passed, cases_hash, results) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ran_at`,
            [
              v.id,
              request.ctx.principal.subject,
              results.length,
              passed,
              runHash(cases, v),
              JSON.stringify(results),
            ],
          )
        ).rows[0]!.ran_at;
        await writeAudit(tx, request.ctx, {
          action: 'plan_tests.run',
          resourceType: 'plan',
          resourceId: p.id,
          data: { version: v.version, total: results.length, passed },
        });
        return {
          versionId: v.id,
          ranAt: ranAt.toISOString(),
          total: results.length,
          passed,
          results,
        };
      });
      return reply.code(201).send(run);
    },
  );

  app.get(
    '/v1/plan-versions/:versionId/test-runs/latest',
    {
      config: { tenancy: 'platform', permission: 'plans:read' },
      schema: {
        tags: ['Plans'],
        summary: 'The latest test run for this version',
        params: versionParams,
        response: { 200: PlanTestRunSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{
            version_id: string;
            ran_at: Date;
            total: number;
            passed: number;
            results: PlanTestRun['results'];
          }>(
            `SELECT version_id, ran_at, total, passed, results FROM plans.test_runs WHERE version_id = $1 ORDER BY ran_at DESC LIMIT 1`,
            [request.params.versionId],
          )
        ).rows[0];
        if (!r) throw notFound('A test run');
        return {
          versionId: r.version_id,
          ranAt: r.ran_at.toISOString(),
          total: r.total,
          passed: r.passed,
          results: r.results,
        };
      }),
  );
};

const asDiffable = (v: VersionRow) => ({
  id: v.id,
  version: v.version,
  document: v.document,
  links: v.links,
  effectiveFrom: v.effective_from,
});

/** Version summary without the checks (list views). */
function toVersionSync(v: VersionRow) {
  return {
    id: v.id,
    planId: v.plan_id,
    version: v.version,
    status: v.status,
    effectiveFrom: v.effective_from,
    effectiveTo: v.effective_to,
    catalogueId: v.catalogue_id,
    contributors: v.contributors,
    createdAt: v.created_at.toISOString(),
    updatedAt: v.updated_at.toISOString(),
    approvedBy: v.approved_by,
    approvedAt: v.approved_at ? v.approved_at.toISOString() : null,
    publishedBy: v.published_by,
    publishedAt: v.published_at ? v.published_at.toISOString() : null,
  };
}
