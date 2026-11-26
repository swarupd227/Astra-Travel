import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AccountReportSchema, ReportPeriodSchema, StatutoryReportSchema, TraceSchema, type AccountReport, type StatutoryReport, type Trace } from '@astra/contracts';
import { AppError, notFound, withTx, writeAudit, type Tx } from '@astra/platform';
import type { AppDeps } from '../app';
import { toCsv } from '../reports/csv';
import { commonErrors } from './shared';

/** The audit trace (E10-F02-S01), statutory data (E10-F02-S02) and account reports (E12-F02-S01). Design: docs/adr/0017. */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodQuery = z.object({ from: day, to: day });
const period = (q: { from: string; to: string }) => {
  const p = ReportPeriodSchema.safeParse(q);
  if (!p.success) {
    const issue = p.error.issues[0]!;
    throw new AppError('validation_failed', issue.message, [{ code: 'period', field: String(issue.path[0] ?? 'to'), message: issue.message }]);
  }
  return p.data;
};
const money = (cents: number | string) => {
  const n = Number(cents);
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- Trace

interface Chain {
  planVersionId: string | null;
  ruleSetId: string | null;
  manualIds: string[];
  worksheetIds: string[];
  templateIds: string[];
  editionIds: { role: string; id: string }[];
  correlationOf: { policyId: string | null };
}

async function resolveChain(tx: Tx, c: Chain, gaps: string[]) {
  const plan = c.planVersionId
    ? (
        await tx.query<{ code: string; version: number; id: string; sha256: string | null; published_by: string | null; published_at: Date | null; approved_by: string | null; schedule_edition_id: string; policy_edition_id: string | null }>(
          `SELECT p.code, v.version, v.id, v.sha256, v.published_by, v.published_at, v.approved_by, p.schedule_edition_id, p.policy_edition_id
             FROM plans.plan_versions v JOIN plans.plans p ON p.id = v.plan_id WHERE v.id = $1`,
          [c.planVersionId],
        )
      ).rows[0]
    : undefined;
  if (c.planVersionId && !plan) gaps.push('The plan version could not be found.');
  const ruleSet = c.ruleSetId ? (await tx.query<{ id: string; version: number; sha256: string | null; approved_by: string | null; published_by: string | null }>(`SELECT id, version, sha256, approved_by, published_by FROM underwriting.rule_sets WHERE id = $1`, [c.ruleSetId])).rows[0] : undefined;
  if (c.ruleSetId && !ruleSet) gaps.push('The rule set could not be found.');

  const worksheets = c.worksheetIds.length ? (await tx.query<{ id: string; manual_id: string; inputs_hash: string }>(`SELECT id, manual_id, inputs_hash FROM rating.worksheets WHERE id = ANY ($1::uuid[]) ORDER BY id`, [c.worksheetIds])).rows : [];
  if (worksheets.length < new Set(c.worksheetIds).size) gaps.push(`${new Set(c.worksheetIds).size - worksheets.length} rating worksheet(s) could not be found.`);
  const manualIds = [...new Set([...worksheets.map((w) => w.manual_id), ...c.manualIds])];
  const manuals = manualIds.length
    ? (await tx.query<{ id: string; code: string; version: number; state: string; benefit: string; sha256: string; approved_by: string | null; published_by: string | null }>(`SELECT id, code, version, state, benefit, sha256, approved_by, published_by FROM rating.manuals WHERE id = ANY ($1::uuid[]) ORDER BY benefit, code`, [manualIds])).rows
    : [];

  const templates = c.templateIds.length
    ? (
        await tx.query<{ id: string; kind: string; version: number; created_by: string; released_by: string | null; edition_id: string; map_id: string; map_version: number }>(
          `SELECT t.id, t.kind, t.version, t.created_by, t.released_by, t.edition_id, t.map_id, m.version AS map_version
             FROM documents.templates t JOIN studio.variable_maps m ON m.id = t.map_id WHERE t.id = ANY ($1::uuid[]) ORDER BY t.kind, t.version`,
          [c.templateIds],
        )
      ).rows
    : [];

  const editionRoles = new Map<string, string>();
  for (const e of c.editionIds) editionRoles.set(e.id, e.role);
  if (plan?.policy_edition_id) editionRoles.set(plan.policy_edition_id, editionRoles.get(plan.policy_edition_id) ?? 'policy form of the plan');
  if (plan) editionRoles.set(plan.schedule_edition_id, editionRoles.get(plan.schedule_edition_id) ?? 'schedule of the plan');
  for (const t of templates) editionRoles.set(t.edition_id, editionRoles.get(t.edition_id) ?? `${t.kind} template source`);
  const editions = editionRoles.size
    ? (await tx.query<{ id: string; form_number: string; edition: string; insurer: string; sha256: string }>(`SELECT id, form_number, edition, insurer, sha256 FROM studio.form_editions WHERE id = ANY ($1::uuid[]) ORDER BY form_number, edition`, [[...editionRoles.keys()]])).rows
    : [];

  // Agents: proposals a person applied to anything in the chain, and agent runs that acted on the policy.
  const subjects = [...editionRoles.keys(), ...manualIds, ...templates.map((t) => t.id), ...templates.map((t) => t.map_id)];
  const proposed = subjects.length
    ? (
        await tx.query<{ agent_id: string; agent_version: number; id: string; prompt_version: string | null; models_served: string[]; kind: string }>(
          `SELECT r.agent_id, r.agent_version, r.id, r.prompt_version, r.models_served, p.kind
             FROM agents.proposals p JOIN agents.runs r ON r.id = p.run_id
            WHERE p.status = 'resolved' AND (p.subject_id = ANY ($1::uuid[]) OR p.resolution->>'appliedTo' = ANY ($2::text[]))
            ORDER BY r.created_at`,
          [subjects, subjects],
        )
      ).rows.map((r) => ({ ...r, role: `Proposed: ${r.kind.replace(/_/g, ' ')}, applied by a person` }))
    : [];
  const performed = c.correlationOf.policyId
    ? (
        await tx.query<{ agent_id: string; agent_version: number; id: string; prompt_version: string | null; models_served: string[] }>(
          `SELECT DISTINCT r.agent_id, r.agent_version, r.id, r.prompt_version, r.models_served
             FROM agents.runs r
            WHERE r.correlation_id IN (SELECT a.correlation_id FROM audit.audit_log a WHERE a.resource_id = $1 AND a.actor_type = 'agent')`,
          [c.correlationOf.policyId],
        )
      ).rows.map((r) => ({ ...r, role: 'Acted on the policy' }))
    : [];

  return {
    plan: plan ? { code: plan.code, version: plan.version, versionId: plan.id, sha256: plan.sha256, publishedBy: plan.published_by, publishedAt: plan.published_at?.toISOString() ?? null, approvedBy: plan.approved_by } : null,
    ruleSet: ruleSet ? { id: ruleSet.id, version: ruleSet.version, sha256: ruleSet.sha256, approvedBy: ruleSet.approved_by, publishedBy: ruleSet.published_by } : null,
    forms: editions.map((e) => ({ role: editionRoles.get(e.id)!, editionId: e.id, formNumber: e.form_number, edition: e.edition, insurer: e.insurer, sha256: e.sha256 })),
    templates: templates.map((t) => ({ id: t.id, kind: t.kind, version: t.version, createdBy: t.created_by, releasedBy: t.released_by, variableMapId: t.map_id, variableMapVersion: t.map_version })),
    manuals: manuals.map((m) => ({ id: m.id, code: m.code, version: m.version, state: m.state, benefit: m.benefit, sha256: m.sha256, approvedBy: m.approved_by, publishedBy: m.published_by })),
    worksheets: worksheets.map((w) => ({ id: w.id, manualId: w.manual_id, inputsHash: w.inputs_hash })),
    agents: [...proposed, ...performed].map((a) => ({ agentId: a.agent_id, agentVersion: a.agent_version, runId: a.id, promptVersion: a.prompt_version, models: a.models_served, role: a.role })),
  };
}

const policyOf = async (tx: Tx, id: string) =>
  (
    await tx.query<{ id: string; number: string; state: string; account_id: string; quote_id: string; plan_version_id: string; rule_set_id: string; manuals: Record<string, { id: string }> }>(
      `SELECT p.id, p.number, p.state, p.account_id, p.quote_id, p.plan_version_id, p.rule_set_id, q.manuals FROM policies.policies p JOIN policies.quotes q ON q.id = p.quote_id WHERE p.id = $1`,
      [id],
    )
  ).rows[0];

const eventOf = async (tx: Tx, seq: string | number | null) => {
  if (seq === null) return null;
  const e = (await tx.query<{ seq: string; type: string; actor: string; actor_name: string | null; occurred_at: Date; reason: string | null }>(`SELECT seq, type, actor, actor_name, occurred_at, reason FROM policies.policy_events WHERE seq = $1`, [seq])).rows[0];
  return e ? { seq: Number(e.seq), type: e.type, actor: e.actor, actorName: e.actor_name, occurredAt: e.occurred_at.toISOString(), reason: e.reason } : null;
};

async function tracePremium(tx: Tx, id: string, by: string): Promise<Trace> {
  const r = (
    await tx.query<{ id: string; number: string; type: string; status: string; policy_id: string | null; policy_event_seq: string | null; premium_cents: string; charge_cents: string; refund_cents: string; tax_cents: string | null; commission_cents: string | null; allocation: unknown; per_benefit: unknown; basis: unknown; commission: unknown; worksheet_ids: string[]; occurred_at: Date; billing_reference: string | null }>(
      `SELECT * FROM billing.premium_records WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!r) throw notFound('The premium record');
  const gaps: string[] = [];
  const policy = r.policy_id ? await policyOf(tx, r.policy_id) : undefined;
  if (r.policy_id && !policy) gaps.push('The policy could not be found.');
  const event = await eventOf(tx, r.policy_event_seq);
  if (r.policy_id && !event) gaps.push('The policy event that moved this premium could not be found.');
  const docs = policy && r.policy_event_seq ? (await tx.query<{ template_id: string }>(`SELECT template_id FROM documents.documents WHERE policy_id = $1 AND event_seq = $2 AND template_id IS NOT NULL`, [policy.id, r.policy_event_seq])).rows : [];
  const chain = await resolveChain(
    tx,
    {
      planVersionId: policy?.plan_version_id ?? null,
      ruleSetId: policy?.rule_set_id ?? null,
      manualIds: r.worksheet_ids.length ? [] : Object.values(policy?.manuals ?? {}).map((m) => m.id),
      worksheetIds: r.worksheet_ids,
      templateIds: docs.map((d) => d.template_id),
      editionIds: [],
      correlationOf: { policyId: policy?.id ?? null },
    },
    gaps,
  );
  if (r.type !== 'programme' && !chain.worksheets.length) gaps.push('No rating worksheet is recorded for this premium.');
  return {
    subject: { type: 'premium_record', id: r.id, label: r.number },
    generatedAt: new Date().toISOString(),
    generatedBy: by,
    record: {
      number: r.number,
      type: r.type,
      status: r.status,
      premium: money(r.premium_cents),
      charge: money(r.charge_cents),
      refund: money(r.refund_cents),
      tax: r.tax_cents === null ? null : money(r.tax_cents),
      commission: r.commission_cents === null ? null : money(r.commission_cents),
      allocation: r.allocation,
      perBenefit: r.per_benefit,
      basis: r.basis,
      commissionDetail: r.commission,
      occurredAt: r.occurred_at.toISOString(),
      billingReference: r.billing_reference,
    },
    policy: policy ? { id: policy.id, number: policy.number, state: policy.state, accountId: policy.account_id, quoteId: policy.quote_id } : null,
    event,
    ...chain,
    gaps,
  };
}

async function traceDocument(tx: Tx, id: string, by: string): Promise<Trace> {
  const d = (
    await tx.query<{ id: string; kind: string; title: string; status: string; policy_id: string | null; template_id: string | null; event_seq: string | null; source: string | null; version: number | null; sha256: string | null; size_bytes: string | null; created_by: string; issued_at: Date }>(
      `SELECT id, kind, title, status, policy_id, template_id, event_seq, source, version, sha256, size_bytes, created_by, issued_at FROM documents.documents WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!d) throw notFound('The document');
  const gaps: string[] = [];
  const policy = d.policy_id ? await policyOf(tx, d.policy_id) : undefined;
  if (d.policy_id && !policy) gaps.push('The policy could not be found.');
  const event = await eventOf(tx, d.event_seq);
  const worksheets = policy && d.event_seq ? (await tx.query<{ worksheet_ids: string[] }>(`SELECT worksheet_ids FROM billing.premium_records WHERE policy_id = $1 AND policy_event_seq <= $2 ORDER BY policy_event_seq DESC LIMIT 1`, [policy.id, d.event_seq])).rows[0]?.worksheet_ids ?? [] : [];
  const chain = await resolveChain(
    tx,
    {
      planVersionId: policy?.plan_version_id ?? null,
      ruleSetId: policy?.rule_set_id ?? null,
      manualIds: Object.values(policy?.manuals ?? {}).map((m) => m.id),
      worksheetIds: worksheets,
      templateIds: d.template_id ? [d.template_id] : [],
      editionIds: [],
      correlationOf: { policyId: policy?.id ?? null },
    },
    gaps,
  );
  if (d.status === 'failed') gaps.push('This document failed to assemble, so there is no issued content.');
  return {
    subject: { type: 'document', id: d.id, label: d.title },
    generatedAt: new Date().toISOString(),
    generatedBy: by,
    record: { kind: d.kind, title: d.title, status: d.status, source: d.source, version: d.version, sha256: d.sha256, sizeBytes: d.size_bytes === null ? null : Number(d.size_bytes), createdBy: d.created_by, issuedAt: d.issued_at.toISOString() },
    policy: policy ? { id: policy.id, number: policy.number, state: policy.state, accountId: policy.account_id, quoteId: policy.quote_id } : null,
    event,
    ...chain,
    gaps,
  };
}

// ---------------------------------------------------------------- Statutory data

const IN_PERIOD = `r.occurred_at >= ($1::date)::timestamp AT TIME ZONE 'UTC' AND r.occurred_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'`;

/**
 * One line per benefit of each premium record, with the entity of the benefit's underwriting arrangement at the time
 * (held in the record's inputs). A programme record has no benefit lines, so its allocation is the line.
 */
const LINES = `WITH recs AS (SELECT r.* FROM billing.premium_records r WHERE ${IN_PERIOD}),
  lines AS (
    SELECT r.id, r.policy_id, coalesce(r.state, '--') AS state,
           coalesce((SELECT CASE WHEN b->>'arrangement' = 'ABIC' THEN 'ABIC' WHEN b->>'arrangement' IS NULL THEN 'UNASSIGNED' ELSE 'VSC' END
                       FROM jsonb_array_elements(r.inputs->'benefits') b WHERE b->>'code' = pb->>'code' LIMIT 1), 'UNASSIGNED') AS entity,
           pb->>'code' AS benefit, round((pb->>'premium')::numeric * 100)::bigint AS cents
      FROM recs r CROSS JOIN LATERAL jsonb_array_elements(r.per_benefit) pb
     WHERE r.type <> 'programme'
    UNION ALL
    SELECT r.id, NULL, coalesce(r.state, '--'), a->>'entity', 'PROGRAMME', round((a->>'premium')::numeric * 100)::bigint
      FROM recs r CROSS JOIN LATERAL jsonb_array_elements(r.allocation) a
     WHERE r.type = 'programme'
  )`;

async function statutory(tx: Tx, from: string, to: string): Promise<StatutoryReport> {
  const params = [from, to];
  const rows = (
    await tx.query<{ state: string; entity: string; benefit: string; transactions: string; policies: string; cents: string }>(
      `${LINES} SELECT state, entity, benefit, count(DISTINCT id) AS transactions, count(DISTINCT policy_id) AS policies, sum(cents) AS cents
         FROM lines GROUP BY state, entity, benefit ORDER BY state, entity, benefit`,
      params,
    )
  ).rows;
  const tax = (
    await tx.query<{ state: string; entity: string; premium: string; tax: string; without: string }>(
      `SELECT coalesce(r.state, '--') AS state, a->>'entity' AS entity, sum(round((a->>'premium')::numeric * 100)) AS premium,
              coalesce(sum(round((a->>'tax')::numeric * 100)), 0) AS tax, count(*) FILTER (WHERE a->>'tax' IS NULL) AS without
         FROM billing.premium_records r CROSS JOIN LATERAL jsonb_array_elements(r.allocation) a
        WHERE ${IN_PERIOD} GROUP BY 1, 2 ORDER BY 1, 2`,
      params,
    )
  ).rows;
  const totals = (
    await tx.query<{ records: string; premium: string; tax: string; partial_tax: string }>(
      `SELECT count(*) AS records, coalesce(sum(r.premium_cents), 0) AS premium, coalesce(sum(r.tax_cents), 0) AS tax,
              -- Tax already worked out on records that are held because another entity's rate is missing.
              coalesce((SELECT sum(round((a->>'tax')::numeric * 100)) FROM billing.premium_records x CROSS JOIN LATERAL jsonb_array_elements(x.allocation) a
                         WHERE x.tax_cents IS NULL AND x.occurred_at >= ($1::date)::timestamp AT TIME ZONE 'UTC' AND x.occurred_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'), 0) AS partial_tax
         FROM billing.premium_records r WHERE ${IN_PERIOD}`,
      params,
    )
  ).rows[0]!;
  const byStatus = (await tx.query<{ status: string; records: string; premium: string }>(`SELECT r.status, count(*) AS records, sum(r.premium_cents) AS premium FROM billing.premium_records r WHERE ${IN_PERIOD} GROUP BY r.status ORDER BY r.status`, params)).rows;
  const unbalanced = (
    await tx.query<{ number: string }>(
      `${LINES} SELECT r.number FROM recs r LEFT JOIN (SELECT id, sum(cents) AS cents FROM lines GROUP BY id) l ON l.id = r.id
        WHERE coalesce(l.cents, 0) <> r.premium_cents ORDER BY r.number LIMIT 100`,
      params,
    )
  ).rows.map((r) => r.number);
  const reportCents = rows.reduce((a, r) => a + Number(r.cents), 0);
  const reportTax = tax.reduce((a, r) => a + Number(r.tax), 0);
  const recordTax = Number(totals.tax) + Number(totals.partial_tax);
  const premiumDifference = reportCents - Number(totals.premium);
  const taxDifference = reportTax - recordTax;
  return {
    from,
    to,
    generatedAt: new Date().toISOString(),
    rows: rows.map((r) => ({ state: r.state, entity: r.entity, benefit: r.benefit, transactions: Number(r.transactions), policies: Number(r.policies), premium: money(r.cents) })),
    byEntity: tax.map((r) => ({ state: r.state, entity: r.entity, premium: money(r.premium), tax: money(r.tax), recordsWithoutTax: Number(r.without) })),
    reconciliation: {
      records: Number(totals.records),
      recordPremium: money(totals.premium),
      reportPremium: money(reportCents),
      premiumDifference: money(premiumDifference),
      recordTax: money(recordTax),
      reportTax: money(reportTax),
      taxDifference: money(taxDifference),
      reconciled: premiumDifference === 0 && taxDifference === 0 && unbalanced.length === 0,
      byStatus: byStatus.map((s) => ({ status: s.status, records: Number(s.records), premium: money(s.premium) })),
      unbalancedRecords: unbalanced,
    },
  };
}

// ---------------------------------------------------------------- Account reports

async function accountReport(tx: Tx, from: string, to: string, accountId: string | null): Promise<AccountReport> {
  const params = [from, to, accountId];
  const base = `WITH recs AS (
      SELECT r.*, a.name AS account_name,
             coalesce((SELECT s.segment FROM onboarding.segment_changes s WHERE s.account_id = r.account_id AND s.status = 'approved' AND s.effective_from <= (r.occurred_at AT TIME ZONE 'UTC')::date
                        ORDER BY s.effective_from DESC, s.decided_at DESC LIMIT 1), 'No segment') AS segment,
             (SELECT p.status FROM policies.policies p WHERE p.id = r.policy_id) AS policy_status
        FROM billing.premium_records r JOIN platform.accounts a ON a.id = r.account_id
       WHERE ${IN_PERIOD} AND ($3::uuid IS NULL OR r.account_id = $3)
    ), cancelled AS (
      SELECT policy_id FROM recs WHERE type = 'cancellation'
    )`;
  const measures = `count(DISTINCT policy_id) FILTER (WHERE type = 'bind') AS sold, coalesce(sum(charge_cents), 0) AS charged, coalesce(sum(refund_cents), 0) AS refunded,
      coalesce(sum(premium_cents), 0) AS net, count(*) FILTER (WHERE type = 'cancellation') AS cancellations, count(*) FILTER (WHERE refund_cents > 0) AS refunds`;
  type M = { key: string; label: string; sold: string; charged: string; refunded: string; net: string; cancellations: string; refunds: string };
  const row = (r: M) => ({ key: r.key, label: r.label, policiesSold: Number(r.sold), premiumCharged: money(r.charged), premiumRefunded: money(r.refunded), netPremium: money(r.net), cancellations: Number(r.cancellations), refunds: Number(r.refunds) });
  const grouped = async (key: string, label: string) => (await tx.query<M>(`${base} SELECT ${key} AS key, ${label} AS label, ${measures} FROM recs GROUP BY 1, 2 ORDER BY sum(premium_cents) DESC, 2`, params)).rows.map(row);
  const totals = (await tx.query<M>(`${base} SELECT 'total' AS key, 'All' AS label, ${measures} FROM recs`, params)).rows[0]!;
  const byAccount = await grouped('account_id::text', 'account_name');
  const bySegment = await grouped('segment', 'segment');
  const byState = await grouped(`coalesce(state, '--')`, `coalesce(state, 'Not state-specific')`);
  // By benefit the amounts come from each record's benefit lines; counts are of records that moved that benefit.
  const byBenefit = (
    await tx.query<M>(
      `${base}, lines AS (
         SELECT r.type, r.policy_id, pb->>'code' AS benefit, round((pb->>'premium')::numeric * 100)::bigint AS cents
           FROM recs r CROSS JOIN LATERAL jsonb_array_elements(r.per_benefit) pb
       )
       SELECT benefit AS key, benefit AS label, count(DISTINCT policy_id) FILTER (WHERE type = 'bind') AS sold,
              coalesce(sum(cents) FILTER (WHERE cents > 0), 0) AS charged, coalesce(-sum(cents) FILTER (WHERE cents < 0), 0) AS refunded, coalesce(sum(cents), 0) AS net,
              count(*) FILTER (WHERE type = 'cancellation') AS cancellations, count(*) FILTER (WHERE cents < 0) AS refunds
         FROM lines GROUP BY benefit ORDER BY sum(cents) DESC, benefit`,
      params,
    )
  ).rows.map(row);
  const conversion = (
    await tx.query<{ account_id: string; account: string; quotes: string; bound: string }>(
      `SELECT q.account_id, a.name AS account, count(*) AS quotes, count(*) FILTER (WHERE q.status = 'bound') AS bound
         FROM policies.quotes q JOIN platform.accounts a ON a.id = q.account_id
        WHERE NOT a.sandbox AND q.created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC' AND q.created_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC' AND ($3::uuid IS NULL OR q.account_id = $3)
        GROUP BY q.account_id, a.name ORDER BY a.name`,
      params,
    )
  ).rows;
  const takeUp = (
    await tx.query<{ benefit: string; name: string; policies: string; of: string }>(
      `WITH sold AS (
         SELECT p.id FROM policies.policies p JOIN platform.accounts a ON a.id = p.account_id
          WHERE NOT a.sandbox AND p.created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC' AND p.created_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC' AND ($3::uuid IS NULL OR p.account_id = $3)
       )
       SELECT b.code AS benefit, min(b.name) AS name, count(DISTINCT b.policy_id) AS policies, (SELECT count(*) FROM sold) AS of
         FROM policies.policy_benefits b JOIN sold s ON s.id = b.policy_id GROUP BY b.code ORDER BY count(DISTINCT b.policy_id) DESC, b.code`,
      params,
    )
  ).rows;
  const share = (n: number, of: number) => (of ? Math.round((n / of) * 10_000) / 10_000 : 0);
  return {
    from,
    to,
    generatedAt: new Date().toISOString(),
    totals: row(totals),
    byAccount,
    bySegment,
    byState,
    byBenefit,
    conversion: conversion.map((c) => ({ accountId: c.account_id, account: c.account, quotes: Number(c.quotes), bound: Number(c.bound), rate: share(Number(c.bound), Number(c.quotes)) })),
    takeUp: takeUp.map((t) => ({ benefit: t.benefit, name: t.name, policies: Number(t.policies), of: Number(t.of), rate: share(Number(t.policies), Number(t.of)) })),
  };
}

export const reportRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  for (const [kind, build] of [
    ['premium-records', tracePremium],
    ['documents', traceDocument],
  ] as const) {
    app.get(
      `/v1/trace/${kind}/:id`,
      {
        config: { tenancy: 'platform', permission: 'audit:read' },
        schema: {
          tags: ['Compliance'],
          summary: kind === 'documents' ? 'Trace a document to its plan, forms, template, manuals, rules and agent versions' : 'Trace a premium to its policy, plan, forms, manuals, worksheets, rules and agent versions',
          description: 'With download=true the trace is sent as a JSON file to keep or send to a regulator. Every trace taken is itself audited.',
          params: z.object({ id: z.uuid() }),
          querystring: z.object({ download: z.enum(['true', 'false']).optional() }),
          response: { 200: TraceSchema, ...commonErrors },
        },
      },
      async (request, reply) => {
        const trace = await withTx(deps.pool, request.ctx, async (tx) => {
          const t = await build(tx, request.params.id, request.ctx.principal.subject);
          await writeAudit(tx, request.ctx, { action: 'trace.taken', resourceType: t.subject.type, resourceId: t.subject.id, accountId: t.policy?.accountId, data: { label: t.subject.label, downloaded: request.query.download === 'true' } });
          return t;
        });
        if (request.query.download === 'true') reply.header('content-disposition', `attachment; filename="trace-${trace.subject.label.replace(/[^A-Za-z0-9._-]+/g, '_')}.json"`);
        return trace;
      },
    );
  }

  app.get(
    '/v1/reports/statutory',
    {
      config: { tenancy: 'platform', permission: 'reports:statutory' },
      schema: {
        tags: ['Reports'],
        summary: 'Premium and policy data by state, entity and benefit, reconciled to the premium records',
        description: 'Premium is by the UTC date of each transaction. The reconciliation compares the report with the premium records it is built from and names any record whose lines do not add up. Sandbox transactions are never recorded as premium, so they are never included.',
        querystring: periodQuery,
        response: { 200: StatutoryReportSchema, ...commonErrors },
      },
    },
    async (request) => {
      const p = period(request.query);
      return withTx(deps.pool, request.ctx, (tx) => statutory(tx, p.from, p.to));
    },
  );

  app.get(
    '/v1/reports/statutory.csv',
    {
      config: { tenancy: 'platform', permission: 'reports:statutory' },
      schema: { tags: ['Reports'], summary: 'The statutory rows as a CSV file, with the reconciliation totals', querystring: periodQuery, produces: ['text/csv'], response: { ...commonErrors } },
    },
    async (request, reply) => {
      const p = period(request.query);
      const r = await withTx(deps.pool, request.ctx, async (tx) => {
        const report = await statutory(tx, p.from, p.to);
        await writeAudit(tx, request.ctx, { action: 'report.exported', resourceType: 'report', resourceId: 'statutory', data: { ...p, reconciled: report.reconciliation.reconciled, premium: report.reconciliation.reportPremium } });
        return report;
      });
      const csv = toCsv(
        ['state', 'entity', 'benefit', 'transactions', 'policies', 'premium'],
        [
          ...r.rows.map((x) => [x.state, x.entity, x.benefit, x.transactions, x.policies, x.premium]),
          ['TOTAL', '', '', '', '', r.reconciliation.reportPremium],
          ['PREMIUM RECORDS', '', '', r.reconciliation.records, '', r.reconciliation.recordPremium],
          ['DIFFERENCE', '', r.reconciliation.reconciled ? 'reconciled' : 'NOT RECONCILED', '', '', r.reconciliation.premiumDifference],
        ],
      );
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="statutory-${p.from}-to-${p.to}.csv"`).send(csv as never);
    },
  );

  app.get(
    '/v1/reports/accounts',
    {
      config: { tenancy: 'account', permission: 'reports:read' },
      schema: {
        tags: ['Reports'],
        summary: 'Sales, premium, take-up, cancellations and refunds by account, segment, state and benefit',
        description: 'Worked out when asked, from the premium records, quotes and policies, so it is always current. A caller sees only the accounts in their scope. Sandbox accounts are excluded.',
        querystring: periodQuery.extend({ accountId: z.uuid().optional() }),
        response: { 200: AccountReportSchema, ...commonErrors },
      },
    },
    async (request) => {
      const p = period(request.query);
      return withTx(deps.pool, request.ctx, (tx) => accountReport(tx, p.from, p.to, request.query.accountId ?? null));
    },
  );

  app.get(
    '/v1/reports/accounts.csv',
    {
      config: { tenancy: 'account', permission: 'reports:read' },
      schema: { tags: ['Reports'], summary: 'The account report as a CSV file', querystring: periodQuery.extend({ accountId: z.uuid().optional() }), produces: ['text/csv'], response: { ...commonErrors } },
    },
    async (request, reply) => {
      const p = period(request.query);
      const r = await withTx(deps.pool, request.ctx, (tx) => accountReport(tx, p.from, p.to, request.query.accountId ?? null));
      const line = (group: string, x: AccountReport['totals']) => [group, x.label, x.policiesSold, x.premiumCharged, x.premiumRefunded, x.netPremium, x.cancellations, x.refunds];
      const csv = toCsv(
        ['group', 'name', 'policies_sold', 'premium_charged', 'premium_refunded', 'net_premium', 'cancellations', 'refunds'],
        [line('total', r.totals), ...r.byAccount.map((x) => line('account', x)), ...r.bySegment.map((x) => line('segment', x)), ...r.byState.map((x) => line('state', x)), ...r.byBenefit.map((x) => line('benefit', x))],
      );
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="accounts-${p.from}-to-${p.to}.csv"`).send(csv as never);
    },
  );
};
