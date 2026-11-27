import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  BatchSchema,
  BillingBatchConfirmed,
  BillingBatchCreated,
  BillingBatchFailed,
  CommissionRuleSchema,
  ConfirmationSchema,
  ControlTotalsSchema,
  CreateBatchSchema,
  CreateCommissionRuleSchema,
  CreateProgrammeRuleSchema,
  PremiumRecordSchema,
  PremiumRecordSummarySchema,
  ProgrammePremiumRequestSchema,
  ProgrammeRuleSchema,
  type Batch,
  type PremiumRecord,
} from '@astra/contracts';
import { compareTotals, fromCents } from '@astra/billing';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  publishEvent,
  withTx,
  writeAudit,
  type Tx,
} from '@astra/platform';
import type { AppDeps } from '../app';
import { commonErrors } from './shared';
import { buildBatch } from '../billing/batch';
import { recalculate } from '../billing/records';

/** Premium records, commission and programme rules, batches and the billing system's confirmations (E08). Design: docs/adr/0013. */

const idParams = z.object({ id: z.uuid() });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface RecordRow {
  id: string;
  number: string;
  type: PremiumRecord['type'];
  status: PremiumRecord['status'];
  account_id: string;
  policy_id: string | null;
  policy_number: string | null;
  programme_id: string | null;
  policy_event_seq: string | null;
  period: string | null;
  state: string | null;
  issues: string[];
  premium_cents: string;
  charge_cents: string;
  refund_cents: string;
  retained_cents: string;
  tax_cents: string | null;
  per_benefit: PremiumRecord['perBenefit'];
  per_traveller: PremiumRecord['perTraveller'];
  allocation: PremiumRecord['allocation'];
  commission: PremiumRecord['commission'];
  basis: Record<string, unknown> | null;
  worksheet_ids: string[];
  occurred_at: Date;
  batch_id: string | null;
  billing_reference: string | null;
  billing_reason: string | null;
  created_at: Date;
}

const RECORD_SELECT = `SELECT r.id, r.number, r.type, r.status, r.account_id, r.policy_id, p.number AS policy_number, r.programme_id, r.policy_event_seq::text, r.period, r.state, r.issues,
       r.premium_cents::text, r.charge_cents::text, r.refund_cents::text, r.retained_cents::text, r.tax_cents::text, r.per_benefit, r.per_traveller, r.allocation, r.commission, r.basis,
       r.worksheet_ids, r.occurred_at, r.batch_id, r.billing_reference, r.billing_reason, r.created_at
  FROM billing.premium_records r LEFT JOIN policies.policies p ON p.id = r.policy_id`;

const c = (v: string) => fromCents(Number(v));
const toRecord = (r: RecordRow): PremiumRecord => ({
  id: r.id,
  number: r.number,
  type: r.type,
  status: r.status,
  accountId: r.account_id,
  policyId: r.policy_id,
  policyNumber: r.policy_number,
  programmeId: r.programme_id,
  policyEventSeq: r.policy_event_seq === null ? null : Number(r.policy_event_seq),
  period: r.period,
  state: r.state,
  issues: r.issues,
  premium: c(r.premium_cents),
  charge: c(r.charge_cents),
  refund: c(r.refund_cents),
  retained: c(r.retained_cents),
  perBenefit: r.per_benefit,
  perTraveller: r.per_traveller,
  allocation: r.allocation,
  commission: r.commission,
  tax: r.tax_cents === null ? null : c(r.tax_cents),
  basis: r.basis,
  worksheetIds: r.worksheet_ids,
  occurredAt: r.occurred_at.toISOString(),
  batchId: r.batch_id,
  billingReference: r.billing_reference,
  billingReason: r.billing_reason,
  createdAt: r.created_at.toISOString(),
});

interface BatchRow {
  id: string;
  number: string;
  status: Batch['status'];
  totals: Batch['totals'];
  sha256: string;
  size_bytes: string;
  channel: 'file' | 'http' | null;
  attempts: number;
  last_error: string | null;
  created_by: string;
  created_at: Date;
  sent_at: Date | null;
  confirmed_at: Date | null;
  next_attempt_at: Date | null;
}
const BATCH_SELECT = `SELECT id, number::text, status, totals, sha256, size_bytes::text, channel, attempts, last_error, created_by, created_at, sent_at, confirmed_at, next_attempt_at FROM billing.batches`;
const toBatch = (b: BatchRow): Batch => ({
  id: b.id,
  number: Number(b.number),
  status: b.status,
  totals: b.totals,
  sha256: b.sha256,
  sizeBytes: Number(b.size_bytes),
  channel: b.channel,
  attempts: b.attempts,
  lastError: b.last_error,
  createdBy: b.created_by,
  createdAt: b.created_at.toISOString(),
  sentAt: iso(b.sent_at),
  confirmedAt: iso(b.confirmed_at),
  nextAttemptAt: iso(b.next_attempt_at),
});

interface RuleRow {
  id: string;
  account_id: string;
  version: number;
  effective_from: string;
  status: 'draft' | 'approved' | 'superseded';
  document: z.infer<typeof CommissionRuleSchema>['document'];
  created_by: string;
  approved_by: string | null;
  approved_at: Date | null;
}
const toRule = (r: RuleRow) => ({
  id: r.id,
  accountId: r.account_id,
  version: r.version,
  effectiveFrom: r.effective_from,
  status: r.status,
  document: r.document,
  createdBy: r.created_by,
  approvedBy: r.approved_by,
  approvedAt: iso(r.approved_at),
});

async function approve(
  tx: Tx,
  table: 'commission_rules' | 'programme_rules',
  id: string,
  by: string,
  group: { column: string; effective: boolean },
) {
  const r = (
    await tx.query<{
      id: string;
      status: string;
      created_by: string;
      account_id: string;
      effective_from: string;
      scope: string;
    }>(
      `SELECT id, status, created_by, account_id, effective_from::text, ${group.column}::text AS scope FROM billing.${table} WHERE id = $1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!r) throw notFound('The rule');
  if (r.status !== 'draft') throw conflict(`This rule is ${r.status}.`);
  if (r.created_by === by)
    throw forbidden('A rule is approved by someone other than the person who made it.');
  await tx.query(
    `UPDATE billing.${table} SET status = 'superseded' WHERE ${group.column} = $1 AND status = 'approved' AND effective_from = $2::date`,
    [r.scope, r.effective_from],
  );
  await tx.query(
    `UPDATE billing.${table} SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
    [id, by],
  );
  return r;
}

export const billingRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  // ---------------- Premium records ----------------

  app.get(
    '/v1/premium-records',
    {
      config: { tenancy: 'account', permission: 'billing:read' },
      schema: {
        tags: ['Billing'],
        summary: 'Premium records, newest first (E08-F01)',
        querystring: z.object({
          accountId: z.uuid().optional(),
          status: z.enum(['held', 'ready', 'batched', 'sent', 'confirmed', 'rejected']).optional(),
          type: z.enum(['bind', 'change', 'cancellation', 'programme']).optional(),
          batchId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: z.object({ items: z.array(PremiumRecordSummarySchema) }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const q = request.query;
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<RecordRow>(
          `${RECORD_SELECT} WHERE ($1::uuid IS NULL OR r.account_id = $1) AND ($2::text IS NULL OR r.status = $2) AND ($3::text IS NULL OR r.type = $3) AND ($4::uuid IS NULL OR r.batch_id = $4) ORDER BY r.created_at DESC, r.number DESC LIMIT $5`,
          [q.accountId ?? null, q.status ?? null, q.type ?? null, q.batchId ?? null, q.limit],
        ),
      );
      return {
        items: rows.map((r) => {
          const x = toRecord(r);
          return {
            id: x.id,
            number: x.number,
            type: x.type,
            status: x.status,
            accountId: x.accountId,
            policyId: x.policyId,
            policyNumber: x.policyNumber,
            programmeId: x.programmeId,
            period: x.period,
            state: x.state,
            issues: x.issues,
            premium: x.premium,
            refund: x.refund,
            commission: x.commission,
            tax: x.tax,
            occurredAt: x.occurredAt,
            batchId: x.batchId,
            billingReference: x.billingReference,
          };
        }),
      };
    },
  );

  app.get(
    '/v1/premium-records/:id',
    {
      config: { tenancy: 'account', permission: 'billing:read' },
      schema: {
        tags: ['Billing'],
        summary:
          'A premium record with its amounts per benefit, traveller and entity, its basis and its worksheets',
        params: idParams,
        response: { 200: PremiumRecordSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<RecordRow>(`${RECORD_SELECT} WHERE r.id = $1`, [request.params.id])
        ).rows[0];
        if (!r) throw notFound('The premium record');
        return toRecord(r);
      }),
  );

  app.get(
    '/v1/policies/:policyId/premium-records',
    {
      config: { tenancy: 'account', permission: 'billing:read' },
      schema: {
        tags: ['Billing'],
        summary:
          'The premium records of a policy, in order, with the status of each refund and charge (E08-F03-S02)',
        params: z.object({ policyId: z.uuid() }),
        response: { 200: z.object({ items: z.array(PremiumRecordSchema) }), ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        if (
          !(
            await tx.query(`SELECT 1 FROM policies.policies WHERE id = $1`, [
              request.params.policyId,
            ])
          ).rowCount
        )
          throw notFound('The policy');
        const { rows } = await tx.query<RecordRow>(
          `${RECORD_SELECT} WHERE r.policy_id = $1 ORDER BY r.policy_event_seq NULLS FIRST, r.created_at`,
          [request.params.policyId],
        );
        return { items: rows.map(toRecord) };
      }),
  );

  app.post(
    '/v1/premium-records/:id/recalculate',
    {
      config: { tenancy: 'account', permission: 'billing:manage' },
      schema: {
        tags: ['Billing'],
        summary:
          'Recalculate a held record after the missing rate, rule or arrangement has been configured',
        params: idParams,
        response: { 200: PremiumRecordSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const out = await recalculate(tx, request.params.id);
        await writeAudit(tx, request.ctx, {
          action: 'premium_record.recalculated',
          resourceType: 'premium_record',
          resourceId: request.params.id,
          data: out,
        });
        return toRecord(
          (await tx.query<RecordRow>(`${RECORD_SELECT} WHERE r.id = $1`, [request.params.id]))
            .rows[0]!,
        );
      }),
  );

  // ---------------- Commission rules ----------------

  app.post(
    '/v1/commission-rules',
    {
      config: { tenancy: 'account', permission: 'billing:manage' },
      schema: {
        tags: ['Billing'],
        summary: 'Propose how an account’s commission is calculated (E08-F02-S01)',
        description:
          'Flat, tiered, volume or none. A second person approves it; until one is approved the account’s records are held.',
        body: CreateCommissionRuleSchema,
        response: { 201: CommissionRuleSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        if (
          !(await tx.query(`SELECT 1 FROM platform.accounts WHERE id = $1`, [b.accountId])).rowCount
        )
          throw notFound('The account');
        const v = (
          await tx.query<{ v: number }>(
            `SELECT coalesce(max(version), 0) + 1 AS v FROM billing.commission_rules WHERE account_id = $1`,
            [b.accountId],
          )
        ).rows[0]!.v;
        const row = (
          await tx.query<RuleRow>(
            `INSERT INTO billing.commission_rules (account_id, version, effective_from, document, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, account_id, version, effective_from::text, status, document, created_by, approved_by, approved_at`,
            [
              b.accountId,
              v,
              b.effectiveFrom,
              JSON.stringify(b.document),
              request.ctx.principal.subject,
            ],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, {
          action: 'commission_rule.created',
          resourceType: 'commission_rule',
          resourceId: row.id,
          accountId: b.accountId,
          data: { version: v, kind: b.document.kind, effectiveFrom: b.effectiveFrom },
        });
        return toRule(row);
      });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/v1/commission-rules',
    {
      config: { tenancy: 'account', permission: 'billing:read' },
      schema: {
        tags: ['Billing'],
        summary: 'Commission rules, newest first',
        querystring: z.object({ accountId: z.uuid().optional() }),
        response: { 200: z.object({ items: z.array(CommissionRuleSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<RuleRow>(
          `SELECT id, account_id, version, effective_from::text, status, document, created_by, approved_by, approved_at FROM billing.commission_rules WHERE ($1::uuid IS NULL OR account_id = $1) ORDER BY created_at DESC LIMIT 200`,
          [request.query.accountId ?? null],
        ),
      );
      return { items: rows.map(toRule) };
    },
  );

  app.post(
    '/v1/commission-rules/:id/approve',
    {
      config: { tenancy: 'account', permission: 'billing:approve' },
      schema: {
        tags: ['Billing'],
        summary: 'Approve a commission rule made by someone else',
        params: idParams,
        response: { 200: CommissionRuleSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = await approve(
          tx,
          'commission_rules',
          request.params.id,
          request.ctx.principal.subject,
          { column: 'account_id', effective: true },
        );
        await writeAudit(tx, request.ctx, {
          action: 'commission_rule.approved',
          resourceType: 'commission_rule',
          resourceId: r.id,
          accountId: r.account_id,
          data: { effectiveFrom: r.effective_from },
        });
        return toRule(
          (
            await tx.query<RuleRow>(
              `SELECT id, account_id, version, effective_from::text, status, document, created_by, approved_by, approved_at FROM billing.commission_rules WHERE id = $1`,
              [r.id],
            )
          ).rows[0]!,
        );
      }),
  );

  // ---------------- Card programme premium (E08-F04-S02) ----------------

  type ProgrammeRule = z.infer<typeof ProgrammeRuleSchema>;
  const PROGRAMME_RULE_SELECT = `SELECT id, programme_id, account_id, version, effective_from::text, basis, rate::text, status, created_by, approved_by FROM billing.programme_rules`;
  const toProgrammeRule = (r: {
    id: string;
    programme_id: string;
    account_id: string;
    version: number;
    effective_from: string;
    basis: 'per_account_per_month';
    rate: string;
    status: 'draft' | 'approved' | 'superseded';
    created_by: string;
    approved_by: string | null;
  }): ProgrammeRule => ({
    id: r.id,
    programmeId: r.programme_id,
    accountId: r.account_id,
    version: r.version,
    effectiveFrom: r.effective_from,
    basis: r.basis,
    rate: r.rate,
    status: r.status,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
  });

  app.post(
    '/v1/programme-premium-rules',
    {
      config: { tenancy: 'account', permission: 'billing:manage' },
      schema: {
        tags: ['Billing'],
        summary: 'Propose a card programme’s premium rate: per eligible account per month',
        body: CreateProgrammeRuleSchema,
        response: { 201: ProgrammeRuleSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const prog = (
          await tx.query<{ account_id: string }>(
            `SELECT account_id FROM card.programmes WHERE id = $1`,
            [b.programmeId],
          )
        ).rows[0];
        if (!prog) throw notFound('The card programme');
        const v = (
          await tx.query<{ v: number }>(
            `SELECT coalesce(max(version), 0) + 1 AS v FROM billing.programme_rules WHERE programme_id = $1`,
            [b.programmeId],
          )
        ).rows[0]!.v;
        const row = (
          await tx.query(
            `INSERT INTO billing.programme_rules (programme_id, account_id, version, effective_from, basis, rate, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, programme_id, account_id, version, effective_from::text, basis, rate::text, status, created_by, approved_by`,
            [
              b.programmeId,
              prog.account_id,
              v,
              b.effectiveFrom,
              b.basis,
              b.rate,
              request.ctx.principal.subject,
            ],
          )
        ).rows[0] as Parameters<typeof toProgrammeRule>[0];
        await writeAudit(tx, request.ctx, {
          action: 'programme_rule.created',
          resourceType: 'programme_rule',
          resourceId: row.id,
          accountId: prog.account_id,
          data: { version: v, rate: b.rate },
        });
        return toProgrammeRule(row);
      });
      return reply.code(201).send(out);
    },
  );

  app.post(
    '/v1/programme-premium-rules/:id/approve',
    {
      config: { tenancy: 'account', permission: 'billing:approve' },
      schema: {
        tags: ['Billing'],
        summary: 'Approve a programme premium rate made by someone else',
        params: idParams,
        response: { 200: ProgrammeRuleSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const r = await approve(
          tx,
          'programme_rules',
          request.params.id,
          request.ctx.principal.subject,
          { column: 'programme_id', effective: true },
        );
        await writeAudit(tx, request.ctx, {
          action: 'programme_rule.approved',
          resourceType: 'programme_rule',
          resourceId: r.id,
          accountId: r.account_id,
          data: { effectiveFrom: r.effective_from },
        });
        return toProgrammeRule(
          (await tx.query(`${PROGRAMME_RULE_SELECT} WHERE id = $1`, [r.id])).rows[0] as Parameters<
            typeof toProgrammeRule
          >[0],
        );
      }),
  );

  app.get(
    '/v1/programme-premium-rules',
    {
      config: { tenancy: 'account', permission: 'billing:read' },
      schema: {
        tags: ['Billing'],
        summary: 'Programme premium rates',
        querystring: z.object({ programmeId: z.uuid().optional() }),
        response: { 200: z.object({ items: z.array(ProgrammeRuleSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query(
          `${PROGRAMME_RULE_SELECT} WHERE ($1::uuid IS NULL OR programme_id = $1) ORDER BY created_at DESC LIMIT 200`,
          [request.query.programmeId ?? null],
        ),
      );
      return { items: (rows as Parameters<typeof toProgrammeRule>[0][]).map(toProgrammeRule) };
    },
  );

  app.post(
    '/v1/programme-premium',
    {
      config: { tenancy: 'account', permission: 'billing:manage' },
      schema: {
        tags: ['Billing'],
        summary: 'Create a card programme’s premium record for a month (E08-F04-S02)',
        description:
          'Counts the accounts eligible on the last day of the month in the eligibility ledger and applies the programme’s approved rate. One record per programme and month; it goes to billing in the same batches as retail premium.',
        body: ProgrammePremiumRequestSchema,
        response: { 201: PremiumRecordSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const { programmeId, month } = request.body;
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const prog = (
          await tx.query<{
            account_id: string;
            code: string;
            name: string;
            underwriter: 'VSC' | 'ABIC';
          }>(
            `SELECT p.account_id, p.code, p.name, m.underwriter FROM card.programmes p JOIN card.master_policies m ON m.id = p.master_policy_id WHERE p.id = $1`,
            [programmeId],
          )
        ).rows[0];
        if (!prog) throw notFound('The card programme');
        const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
          .toISOString()
          .slice(0, 10);
        const rule = (
          await tx.query<{ rate: string; version: number }>(
            `SELECT rate::text, version FROM billing.programme_rules WHERE programme_id = $1 AND status = 'approved' AND effective_from <= $2::date ORDER BY effective_from DESC, version DESC LIMIT 1`,
            [programmeId, last],
          )
        ).rows[0];
        if (!rule)
          throw new AppError(
            'precondition_failed',
            `Programme ${prog.code} has no approved premium rate in force on ${last}.`,
            [{ code: 'no_programme_rule', field: 'programmeId', message: 'Approve a rate first' }],
          );
        if (
          (
            await tx.query(
              `SELECT 1 FROM billing.premium_records WHERE programme_id = $1 AND period = $2 AND type = 'programme'`,
              [programmeId, month],
            )
          ).rowCount
        )
          throw conflict(`The premium record for ${prog.code} in ${month} already exists.`);
        const accounts = Number(
          (
            await tx.query<{ n: string }>(
              `SELECT count(DISTINCT account_ref)::text AS n FROM card.eligibility_periods WHERE programme_id = $1 AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
              [programmeId, last],
            )
          ).rows[0]!.n,
        );
        const cents = Math.round(Number(rule.rate) * accounts * 100);
        const seq = Number(
          (await tx.query<{ n: string }>(`SELECT nextval('billing.record_seq') AS n`)).rows[0]!.n,
        );
        const basis = {
          basis: 'per_account_per_month',
          rate: rule.rate,
          accounts,
          month,
          ruleVersion: rule.version,
        };
        const id = (
          await tx.query<{ id: string }>(
            `INSERT INTO billing.premium_records (number, type, account_id, programme_id, period, status, premium_cents, charge_cents, refund_cents, retained_cents, commission_cents, tax_cents, allocation, basis, inputs, occurred_at)
             VALUES ($1, 'programme', $2, $3, $4, 'ready', $5, $5, 0, 0, 0, 0, $6, $7, $8, now()) RETURNING id`,
            [
              `BR-${new Date().getUTCFullYear()}-${String(seq).padStart(6, '0')}`,
              prog.account_id,
              programmeId,
              month,
              cents,
              JSON.stringify([
                {
                  entity: prog.underwriter,
                  arrangement: prog.underwriter,
                  premium: fromCents(cents),
                  taxRatePercent: null,
                  tax: null,
                },
              ]),
              JSON.stringify(basis),
              JSON.stringify({ programme: prog.code, month, accounts }),
            ],
          )
        ).rows[0]!.id;
        await writeAudit(tx, request.ctx, {
          action: 'programme_premium.recorded',
          resourceType: 'premium_record',
          resourceId: id,
          accountId: prog.account_id,
          data: { programme: prog.code, month, accounts, premium: fromCents(cents) },
        });
        return toRecord(
          (await tx.query<RecordRow>(`${RECORD_SELECT} WHERE r.id = $1`, [id])).rows[0]!,
        );
      });
      return reply.code(201).send(out);
    },
  );

  // ---------------- Batches (E08-F03, E08-F04-S01) ----------------

  app.post(
    '/v1/billing/batches',
    {
      config: { tenancy: 'platform', permission: 'billing:manage' },
      schema: {
        tags: ['Billing'],
        summary: 'Collect the ready premium records into a batch with control totals',
        description:
          'Each record is in at most one batch, so none is sent twice. The batch file is written as a stream with a header and a trailer that both carry the control totals; the worker sends it. Held records are not included.',
        body: CreateBatchSchema,
        response: {
          201: BatchSchema,
          200: z.object({ batch: z.null(), message: z.string() }),
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const out = await withTx(deps.pool, request.ctx, async (tx) => {
        const b = await buildBatch(
          tx,
          deps.files,
          request.ctx.principal.subject,
          request.body.limit,
        );
        if (!b) return null;
        await publishEvent(
          tx,
          request.ctx,
          BillingBatchCreated,
          {
            batchId: b.id,
            number: b.number,
            count: b.totals.count,
            premium: b.totals.premium,
            commission: b.totals.commission,
            tax: b.totals.tax,
          },
          { accountId: null },
        );
        await writeAudit(tx, request.ctx, {
          action: 'billing_batch.created',
          resourceType: 'billing_batch',
          resourceId: b.id,
          data: { number: b.number, totals: b.totals, sha256: b.sha256 },
        });
        return toBatch(
          (await tx.query<BatchRow>(`${BATCH_SELECT} WHERE id = $1`, [b.id])).rows[0]!,
        );
      });
      if (!out)
        return reply
          .code(200)
          .send({ batch: null, message: 'No premium record is ready to send.' });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/v1/billing/batches',
    {
      config: { tenancy: 'platform', permission: 'billing:read' },
      schema: {
        tags: ['Billing'],
        summary: 'Batches, newest first',
        querystring: z.object({
          status: z
            .enum(['ready', 'sent', 'confirmed', 'mismatch', 'unconfirmed', 'rejected'])
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ items: z.array(BatchSchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<BatchRow>(
          `${BATCH_SELECT} WHERE ($1::text IS NULL OR status = $1) ORDER BY number DESC LIMIT $2`,
          [request.query.status ?? null, request.query.limit],
        ),
      );
      return { items: rows.map(toBatch) };
    },
  );

  app.get(
    '/v1/billing/batches/:id',
    {
      config: { tenancy: 'platform', permission: 'billing:read' },
      schema: {
        tags: ['Billing'],
        summary: 'A batch',
        params: idParams,
        response: { 200: BatchSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const b = (await tx.query<BatchRow>(`${BATCH_SELECT} WHERE id = $1`, [request.params.id]))
          .rows[0];
        if (!b) throw notFound('The batch');
        return toBatch(b);
      }),
  );

  app.get(
    '/v1/billing/batches/:id/file',
    {
      config: { tenancy: 'platform', permission: 'billing:read' },
      schema: {
        tags: ['Billing'],
        summary: 'The batch file (newline-delimited JSON with header and trailer)',
        params: idParams,
        produces: ['application/x-ndjson'],
        response: { ...commonErrors },
      },
    },
    async (request, reply) => {
      const b = await withTx(deps.pool, request.ctx, async (tx) => {
        const r = (
          await tx.query<{ file_key: string; number: string; sha256: string }>(
            `SELECT file_key, number::text, sha256 FROM billing.batches WHERE id = $1`,
            [request.params.id],
          )
        ).rows[0];
        if (!r) throw notFound('The batch');
        await writeAudit(tx, request.ctx, {
          action: 'billing_batch.downloaded',
          resourceType: 'billing_batch',
          resourceId: request.params.id,
          data: {},
        });
        return r;
      });
      return reply
        .header('content-type', 'application/x-ndjson')
        .header('content-disposition', `attachment; filename="astra-batch-${b.number}.ndjson"`)
        .header('x-content-sha256', b.sha256)
        .send(deps.files.read(b.file_key) as never);
    },
  );

  app.post(
    '/v1/billing/batches/:id/retry',
    {
      config: { tenancy: 'platform', permission: 'billing:manage' },
      schema: {
        tags: ['Billing'],
        summary:
          'Send a batch again that billing did not confirm, or whose totals billing did not agree',
        description: 'The same batch ID and file go again, so billing can recognise a repeat.',
        params: idParams,
        response: { 200: BatchSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const b = (
          await tx.query<{ status: string }>(
            `SELECT status FROM billing.batches WHERE id = $1 FOR UPDATE`,
            [request.params.id],
          )
        ).rows[0];
        if (!b) throw notFound('The batch');
        if (!['unconfirmed', 'mismatch', 'ready'].includes(b.status))
          throw conflict(
            `This batch is ${b.status}; only an unconfirmed or mismatched batch is sent again.`,
          );
        await tx.query(
          `UPDATE billing.batches SET status = 'ready', attempts = 0, next_attempt_at = NULL, last_error = NULL, confirmation = NULL WHERE id = $1`,
          [request.params.id],
        );
        // The records went out with the batch, so they stay sent; a resend does not take a record into another batch.
        await writeAudit(tx, request.ctx, {
          action: 'billing_batch.retried',
          resourceType: 'billing_batch',
          resourceId: request.params.id,
          data: {},
        });
        return toBatch(
          (await tx.query<BatchRow>(`${BATCH_SELECT} WHERE id = $1`, [request.params.id])).rows[0]!,
        );
      }),
  );

  app.post(
    '/v1/billing/confirmations',
    {
      config: { tenancy: 'platform', permission: 'billing:confirm' },
      schema: {
        tags: ['Billing'],
        summary:
          'The billing system confirms what it received of a batch, and what it did with each record (E08-F03-S01)',
        description:
          'The counts and totals are compared with the batch’s own control totals: a difference marks the batch `mismatch` and raises an alert, and no record is confirmed. Otherwise every record of the batch must be answered, accepted (with billing’s reference) or rejected (with the reason). Repeating a confirmation returns the result.',
        body: ConfirmationSchema,
        response: {
          200: z.object({
            batchId: z.uuid(),
            status: z.enum(['confirmed', 'mismatch', 'rejected']),
            differences: z.array(z.string()),
            accepted: z.number().int(),
            rejected: z.number().int(),
            totals: ControlTotalsSchema,
          }),
          ...commonErrors,
        },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const b = request.body;
        const batch = (
          await tx.query<{ id: string; number: string; status: string; totals: Batch['totals'] }>(
            `SELECT id, number::text, status, totals FROM billing.batches WHERE id = $1 FOR UPDATE`,
            [b.batchId],
          )
        ).rows[0];
        if (!batch) throw notFound('The batch');
        const counts = async () => {
          const r = (
            await tx.query<{ accepted: string; rejected: string }>(
              `SELECT count(*) FILTER (WHERE status = 'confirmed')::text AS accepted, count(*) FILTER (WHERE status = 'rejected')::text AS rejected FROM billing.premium_records WHERE batch_id = $1`,
              [b.batchId],
            )
          ).rows[0]!;
          return { accepted: Number(r.accepted), rejected: Number(r.rejected) };
        };
        if (['confirmed', 'rejected'].includes(batch.status))
          return {
            batchId: batch.id,
            status: batch.status as 'confirmed' | 'rejected',
            differences: [],
            ...(await counts()),
            totals: batch.totals,
          };
        if (batch.status === 'mismatch')
          throw conflict('This batch was marked as a mismatch. Send it again, and confirm after.');
        if (batch.status === 'ready') throw conflict('This batch has not been sent yet.');
        const check = compareTotals(batch.totals, b.received);
        if (!check.ok) {
          await tx.query(
            `UPDATE billing.batches SET status = 'mismatch', last_error = $2, confirmation = $3 WHERE id = $1`,
            [batch.id, `Control totals differ: ${check.differences.join('; ')}`, JSON.stringify(b)],
          );
          await publishEvent(
            tx,
            request.ctx,
            BillingBatchFailed,
            {
              batchId: batch.id,
              number: Number(batch.number),
              status: 'mismatch',
              reason: check.differences.join('; '),
            },
            { accountId: null },
          );
          await writeAudit(tx, request.ctx, {
            action: 'billing_batch.mismatch',
            resourceType: 'billing_batch',
            resourceId: batch.id,
            data: { differences: check.differences },
          });
          return {
            batchId: batch.id,
            status: 'mismatch' as const,
            differences: check.differences,
            accepted: 0,
            rejected: 0,
            totals: batch.totals,
          };
        }
        const members = new Set(
          (
            await tx.query<{ id: string }>(
              `SELECT id FROM billing.premium_records WHERE batch_id = $1`,
              [batch.id],
            )
          ).rows.map((r) => r.id),
        );
        const answered = new Set(b.records.map((r) => r.recordId));
        const stray = [...answered].filter((id) => !members.has(id));
        const missing = [...members].filter((id) => !answered.has(id));
        if (stray.length || missing.length || answered.size !== b.records.length)
          throw new AppError(
            'validation_failed',
            `Answer every record of the batch once: ${stray.length} are not in it, ${missing.length} were not answered.`,
            [{ code: 'records', field: 'records', message: 'Every record of the batch, once' }],
          );
        for (const r of b.records) {
          await tx.query(
            `UPDATE billing.premium_records SET status = $2, billing_reference = $3, billing_reason = $4 WHERE id = $1 AND batch_id = $5`,
            [
              r.recordId,
              r.status === 'accepted' ? 'confirmed' : 'rejected',
              r.reference ?? null,
              r.reason ?? null,
              batch.id,
            ],
          );
        }
        const n = await counts();
        const status = n.rejected ? 'rejected' : 'confirmed';
        await tx.query(
          `UPDATE billing.batches SET status = $2, confirmed_at = now(), next_attempt_at = NULL, confirmation = $3 WHERE id = $1`,
          [batch.id, status, JSON.stringify(b)],
        );
        if (n.rejected)
          await publishEvent(
            tx,
            request.ctx,
            BillingBatchFailed,
            {
              batchId: batch.id,
              number: Number(batch.number),
              status: 'rejected',
              reason: `${n.rejected} record${n.rejected === 1 ? '' : 's'} rejected by billing`,
            },
            { accountId: null },
          );
        else
          await publishEvent(
            tx,
            request.ctx,
            BillingBatchConfirmed,
            { batchId: batch.id, number: Number(batch.number), accepted: n.accepted, rejected: 0 },
            { accountId: null },
          );
        await writeAudit(tx, request.ctx, {
          action: 'billing_batch.confirmed',
          resourceType: 'billing_batch',
          resourceId: batch.id,
          data: { status, ...n },
        });
        return {
          batchId: batch.id,
          status: status as 'confirmed' | 'rejected',
          differences: [],
          ...n,
          totals: batch.totals,
        };
      }),
  );
};
