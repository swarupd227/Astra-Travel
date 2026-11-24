import Decimal from 'decimal.js';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  BindRequestSchema,
  CreateQuoteRequestSchema,
  EvaluationInputSchema,
  PolicyBound,
  PolicySchema,
  PolicySummarySchema,
  PolicyVerificationRequestSchema,
  PolicyVerificationSchema,
  QuoteIssued,
  QuoteSchema,
  UpdateSelectionRequestSchema,
  type CatalogueDocument,
  type PlanDocument,
  type Policy,
  type PolicyEvent,
  type PolicySnapshot,
  type PolicyVerification,
  type Quote,
} from '@astra/contracts';
import { AppError, canSeeAccount, conflict, forbidden, notFound, preconditionFailed, publishEvent, withIdempotency, withTx, writeAudit, type Tx } from '@astra/platform';
import { benefitLimits, CoverageError, inForce, policyCoverage, policyNumber, project, reviewPeriodEnd } from '@astra/policies';
import type { AppDeps } from '../app';
import { commonErrors, idempotencyHeaders, idempotencyKey } from './shared';
import { buildQuote, HELD_REASON, normalise, REFERRED_REASON, todayUtc, type BuiltQuote, type NormalisedQuoteRequest, type Pinned } from './quote-core';
import { runEvaluation } from './underwriting-evaluate';

/** Quotes, bind, the policy record and cover verification (E04, E05). Design: docs/adr/0010. */

interface QuoteRow {
  id: string;
  account_id: string;
  plan_id: string;
  plan_version_id: string;
  rule_set_id: string;
  state: string;
  status: 'open' | 'bound' | 'expired';
  revision: number;
  request: NormalisedQuoteRequest;
  selection: string[];
  result: Omit<Quote, 'id' | 'accountId' | 'status' | 'revision' | 'createdAt' | 'expiresAt'>;
  manuals: Record<string, { id: string; code: string; version: number }>;
  created_at: Date;
  expires_at: Date;
  bound_policy_id: string | null;
}

const toQuote = (r: QuoteRow): Quote => ({
  ...r.result,
  id: r.id,
  accountId: r.account_id,
  status: r.status === 'open' && r.expires_at.getTime() < Date.now() ? 'expired' : r.status,
  revision: r.revision,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
});

async function findQuote(tx: Tx, id: string, lock = false): Promise<QuoteRow> {
  const r = (await tx.query<QuoteRow>(`SELECT * FROM policies.quotes WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!r) throw notFound('The quote');
  return r;
}

const pinnedOf = (q: QuoteRow): Pinned => ({ planVersionId: q.plan_version_id, ruleSetId: q.rule_set_id, manuals: Object.fromEntries(Object.entries(q.manuals).map(([b, m]) => [b, m.id])) });

const toEvent = (e: { seq: string | number; type: PolicyEvent['type']; occurred_at: Date; actor: string; actor_name: string | null; reason: string | null; data: Record<string, unknown> }): PolicyEvent => ({
  seq: Number(e.seq),
  type: e.type,
  occurredAt: e.occurred_at.toISOString(),
  actor: e.actor,
  actorName: e.actor_name,
  reason: e.reason,
  data: e.data,
});

/** The policy as it is now, or as it was at a moment (E05-F01-S02). */
async function policyView(tx: Tx, id: string, asOf?: string): Promise<Policy> {
  const p = (await tx.query<{ id: string; number: string; account_id: string }>(`SELECT id, number, account_id FROM policies.policies WHERE id = $1`, [id])).rows[0];
  if (!p) throw notFound('The policy');
  const events = (
    await tx.query<Parameters<typeof toEvent>[0]>(`SELECT seq, type, occurred_at, actor, actor_name, reason, data FROM policies.policy_events WHERE policy_id = $1 ORDER BY seq`, [id])
  ).rows.map(toEvent);
  const projected = project(events, asOf);
  if (!projected) throw notFound(`The policy as it was at ${asOf}`);
  const history = asOf ? events.filter((e) => Date.parse(e.occurredAt) <= Date.parse(asOf)) : events;
  return { id: p.id, number: p.number, accountId: p.account_id, status: projected.status, asOf: asOf ?? null, record: projected.record, history };
}

async function storeWorksheets(tx: Tx, actor: string, built: { worksheets: { benefit: string; travellerId: string; manualId: string; inputsHash: string; request: unknown; result: unknown }[] }) {
  const ids: Record<string, string> = {};
  for (const w of built.worksheets) {
    const row = (
      await tx.query<{ id: string }>(`INSERT INTO rating.worksheets (manual_id, inputs_hash, request, result, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
        w.manualId,
        w.inputsHash,
        JSON.stringify(w.request),
        JSON.stringify(w.result),
        actor,
      ])
    ).rows[0]!;
    ids[`${w.benefit}:${w.travellerId}`] = row.id;
  }
  return ids;
}

const withWorksheetIds = (body: BuiltQuote['body'], ids: Record<string, string>) => ({
  ...body,
  premium: body.premium ? { ...body.premium, lines: body.premium.lines.map((l) => ({ ...l, worksheetId: ids[`${l.benefit}:${l.travellerId}`]! })) } : null,
});

const quoteParams = z.object({ quoteId: z.uuid() });
const policyParams = z.object({ policyId: z.uuid() });

export const policyRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  const validDays = deps.config.QUOTE_VALID_DAYS;

  // ---------------- Quotes ----------------

  app.post(
    '/v1/quotes',
    {
      config: { tenancy: 'account', permission: 'quotes:create' },
      schema: {
        tags: ['Quotes'],
        summary: 'Quote a trip for one or more travellers (E04-F01-S01)',
        description:
          'Prices every benefit for every traveller with the published rate manuals, decides eligibility with the plan’s rule set, and returns premium per benefit, per traveller and in total, the amount on the account’s billing basis, a worksheet reference per line, cover dates, the state disclosure, and the plan, rule set and manual versions used. Each error has a code, field and message.',
        body: CreateQuoteRequestSchema,
        response: { 201: QuoteSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const b = request.body;
      if (!canSeeAccount(request.ctx.principal, b.accountId)) throw forbidden('You cannot quote for this account.');
      const quote = await withTx(deps.pool, request.ctx, async (tx) => {
        const acct = (await tx.query<{ status: string }>(`SELECT status FROM platform.accounts WHERE id = $1`, [b.accountId])).rows[0];
        if (!acct) throw notFound('The account');
        if (acct.status === 'suspended' || acct.status === 'closed') throw preconditionFailed(`The account is ${acct.status}; it cannot sell cover.`);
        const req = normalise(b, todayUtc());
        const built = await buildQuote(tx, request.ctx, req, validDays);
        const ids = await storeWorksheets(tx, request.ctx.principal.subject, built);
        const body = withWorksheetIds(built.body, ids);
        const row = (
          await tx.query<QuoteRow>(
            `INSERT INTO policies.quotes (account_id, plan_id, plan_version_id, rule_set_id, state, request, selection, result, manuals, disclosure, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $12)) RETURNING *`,
            [b.accountId, built.planId, built.planVersionId, built.ruleSetId, b.state, JSON.stringify(req), req.selection, JSON.stringify(body), JSON.stringify(body.manuals), body.disclosure ? JSON.stringify(body.disclosure) : null, request.ctx.principal.subject, validDays],
          )
        ).rows[0]!;
        await publishEvent(tx, request.ctx, QuoteIssued, { quoteId: row.id, planCode: body.plan.code, state: b.state, outcome: body.outcome, total: body.premium?.total ?? null }, { accountId: b.accountId });
        await writeAudit(tx, request.ctx, { action: 'quote.created', resourceType: 'quote', resourceId: row.id, accountId: b.accountId, data: { plan: body.plan.code, planVersion: body.plan.version, ruleSet: body.ruleSet.version, manuals: body.manuals, outcome: body.outcome, total: body.premium?.total ?? null } });
        return toQuote(row);
      });
      return reply.code(201).send(quote);
    },
  );

  app.get(
    '/v1/quotes',
    {
      config: { tenancy: 'account', permission: 'quotes:read' },
      schema: {
        tags: ['Quotes'],
        summary: 'Quotes you can see, newest first',
        querystring: z.object({ accountId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }),
        response: { 200: z.object({ items: z.array(QuoteSchema.pick({ id: true, accountId: true, status: true, revision: true, createdAt: true, expiresAt: true, state: true, outcome: true, bindable: true }).extend({ planCode: z.string(), total: z.string().nullable() })) }), ...commonErrors },
      },
    },
    async (request) => {
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<QuoteRow>(`SELECT * FROM policies.quotes WHERE ($1::uuid IS NULL OR account_id = $1) ORDER BY created_at DESC LIMIT $2`, [request.query.accountId ?? null, request.query.limit]),
      );
      return {
        items: rows.map((r) => {
          const q = toQuote(r);
          return { id: q.id, accountId: q.accountId, status: q.status, revision: q.revision, createdAt: q.createdAt, expiresAt: q.expiresAt, state: q.state, outcome: q.outcome, bindable: q.bindable, planCode: q.plan.code, total: q.premium?.total ?? null };
        }),
      };
    },
  );

  app.get(
    '/v1/quotes/:quoteId',
    {
      config: { tenancy: 'account', permission: 'quotes:read' },
      schema: { tags: ['Quotes'], summary: 'A quote', params: quoteParams, response: { 200: QuoteSchema, ...commonErrors } },
    },
    async (request) => withTx(deps.pool, request.ctx, async (tx) => toQuote(await findQuote(tx, request.params.quoteId))),
  );

  app.put(
    '/v1/quotes/:quoteId/selection',
    {
      config: { tenancy: 'account', permission: 'quotes:create' },
      schema: {
        tags: ['Quotes'],
        summary: 'Add or remove optional benefits and re-rate the same quote (E04-F01-S02)',
        description: 'The quote keeps its ID and the plan, rule set and manual versions it was made with; its revision counts the changes. A benefit that cannot be chosen is refused with the reason.',
        params: quoteParams,
        body: UpdateSelectionRequestSchema,
        response: { 200: QuoteSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx) => {
        const q = await findQuote(tx, request.params.quoteId, true);
        if (q.status !== 'open') throw conflict(`This quote is ${q.status}.`);
        if (q.expires_at.getTime() < Date.now()) throw conflict('This quote has expired; make a new one.');
        const req: NormalisedQuoteRequest = { ...q.request, selection: request.body.selection };
        const built = await buildQuote(tx, request.ctx, req, validDays, pinnedOf(q));
        const ids = await storeWorksheets(tx, request.ctx.principal.subject, built);
        const body = withWorksheetIds(built.body, ids);
        const row = (
          await tx.query<QuoteRow>(
            `UPDATE policies.quotes SET request = $2, selection = $3, result = $4, revision = revision + 1, updated_at = now(), disclosure = $5 WHERE id = $1 RETURNING *`,
            [q.id, JSON.stringify(req), req.selection, JSON.stringify(body), body.disclosure ? JSON.stringify(body.disclosure) : null],
          )
        ).rows[0]!;
        await writeAudit(tx, request.ctx, { action: 'quote.reselected', resourceType: 'quote', resourceId: q.id, accountId: q.account_id, data: { revision: row.revision, selection: req.selection, total: body.premium?.total ?? null } });
        return toQuote(row);
      }),
  );

  // ---------------- Bind ----------------

  app.post(
    '/v1/quotes/:quoteId/bind',
    {
      config: { tenancy: 'account', permission: 'quotes:create' },
      schema: {
        tags: ['Quotes'],
        summary: 'Bind a quote to a policy (E04-F02-S01, E04-F02-S02)',
        description:
          'Needs an Idempotency-Key: a repeated request returns the original policy. Refused unless the traveller confirmed they are able to travel, acknowledged the state disclosure, and the payment system’s confirmation matches the premium to the cent. Eligibility is decided again at bind: a referral or sanctions hold stops it and names the referral.',
        headers: idempotencyHeaders,
        params: quoteParams,
        body: BindRequestSchema,
        response: { 201: PolicySchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const key = idempotencyKey(request);
      const principal = request.ctx.principal;
      const today = todayUtc();

      // Step 1, committed on its own so that a referral raised here is kept even when the bind is refused.
      // A replay of a bind that already succeeded skips this step.
      const replay = await withTx(deps.pool, request.ctx, async (tx) =>
        key ? (await tx.query(`SELECT 1 FROM platform.idempotency_keys WHERE principal = $1 AND key = $2`, [principal.subject, key])).rowCount === 1 : false,
      );
      if (!replay) {
        const blocked = await withTx(deps.pool, request.ctx, async (tx) => {
          const q = await findQuote(tx, request.params.quoteId);
          const quote = toQuote(q);
          if (q.status === 'bound') {
            const n = (await tx.query<{ number: string }>(`SELECT number FROM policies.policies WHERE id = $1`, [q.bound_policy_id])).rows[0];
            return conflict(`This quote is already bound as policy ${n?.number ?? ''}.`);
          }
          if (quote.status === 'expired') return conflict('This quote has expired; make a new one.');
          const bindErrors: { code: string; field: string; message: string }[] = [];
          // A referral or hold is handled below (it raises or checks a referral); everything else refuses the bind.
          const hard = quote.notBindable.filter((r) => r !== REFERRED_REASON && r !== HELD_REASON);
          if (hard.length) bindErrors.push({ code: 'not_bindable', field: 'quote', message: hard.join(' ') });
          if (!quote.disclosure) bindErrors.push({ code: 'no_disclosure', field: 'acknowledgement', message: 'There is no disclosure to acknowledge.' });
          else if (b.acknowledgement.disclosureVersion !== quote.disclosure.version) bindErrors.push({ code: 'disclosure_not_acknowledged', field: 'acknowledgement.disclosureVersion', message: `The required disclosure version is ${quote.disclosure.version}; acknowledge that one.` });
          if (quote.premium && !new Decimal(b.payment.amount).eq(quote.premium.total)) bindErrors.push({ code: 'payment_not_confirmed', field: 'payment.amount', message: `The payment of ${b.payment.amount} does not match the premium of ${quote.premium.total}, so the premium is not confirmed.` });
          if (bindErrors.length) return new AppError('validation_failed', bindErrors[0]!.message, bindErrors);
          const evalInput = EvaluationInputSchema.parse({
            stage: 'bind',
            asOf: today,
            travellers: q.request.travellers.map((t) => ({ id: t.id, firstName: t.firstName, lastName: t.lastName, dateOfBirth: t.dateOfBirth, age: t.age, costPerTraveller: t.costPerTraveller })),
            trip: { purchaseDate: today, premiumReceivedDate: today, initialDepositDate: q.request.trip.initialDepositDate, departureDate: q.request.trip.departureDate, returnDate: q.request.trip.returnDate, destinations: q.request.trip.destinations.map((d) => ({ country: d.country, region: d.region })), totalTripCost: q.request.travellers.reduce((a, t) => a.plus(t.costPerTraveller), new Decimal(0)).toFixed(2) },
            insuredPercent: q.request.insuredPercent,
            ableToTravel: true,
            businessSegment: q.request.businessSegment,
            term: quote.plan.term,
            benefits: quote.benefits.filter((x) => x.selected).map((x) => x.code),
          });
          const args = { planVersionId: q.plan_version_id, ruleSetId: q.rule_set_id, caseRef: q.id, input: evalInput };
          const evaluation = await runEvaluation(tx, request.ctx, { ...args, persist: false });
          if (evaluation.outcome === 'held' || evaluation.outcome === 'referred') {
            // A person's decision on this case settles it: cleared lets the bind through, declined stops it.
            const kind = evaluation.outcome === 'held' ? 'sanctions' : 'underwriting';
            const decided = (await tx.query<{ status: string; id: string }>(`SELECT status, id FROM underwriting.referrals WHERE case_ref = $1 AND kind = $2 AND status <> 'open' ORDER BY decided_at DESC LIMIT 1`, [q.id, kind])).rows[0];
            if (decided?.status === 'declined') return new AppError('precondition_failed', `An underwriter declined this case (referral ${decided.id}), so it cannot be bound.`, [{ code: 'referral_declined', field: 'quote', message: decided.id }]);
            if (decided?.status !== 'approved') {
              const raised = await runEvaluation(tx, request.ctx, { ...args, persist: true });
              return evaluation.outcome === 'held'
                ? new AppError('precondition_failed', `The bind is held for review: a possible sanctions match (referral ${raised.referralId}).`, [{ code: 'sanctions_hold', field: 'quote', message: raised.referralId ?? 'held' }])
                : new AppError('precondition_failed', `An underwriter must review this case before it can be bound (referral ${raised.referralId}).`, [{ code: 'referral_required', field: 'quote', message: raised.referralId ?? 'referred' }]);
            }
          }          if (evaluation.outcome === 'ineligible') return new AppError('validation_failed', `Not eligible: ${evaluation.reasons.join(' ')}`, evaluation.reasons.map((m) => ({ code: 'ineligible', field: 'quote', message: m })));
          const cfarChosen = quote.premium?.perBenefit.some((x) => x.benefit === 'CFAR') ?? false;
          if (evaluation.waiver.applies !== quote.waiver.applies || (cfarChosen && !evaluation.cfar.offered)) {
            return new AppError('conflict', 'The conditions for the pre-existing condition waiver or CFAR have changed since the quote (the time-sensitive period has passed). Make a new quote.');
          }
          return null;
        });
        if (blocked) throw blocked;
      }

      // Step 2: the bind itself, exactly once for the key.
      const result = await withTx(deps.pool, request.ctx, async (tx) => {
        const owner = await findQuote(tx, request.params.quoteId);
        return withIdempotency(tx, request.ctx, { key, method: 'POST', path: `/v1/quotes/${request.params.quoteId}/bind`, body: b, accountId: owner.account_id }, async () => {
          const q = await findQuote(tx, request.params.quoteId, true);
          if (q.status === 'bound') {
            const n = (await tx.query<{ number: string }>(`SELECT number FROM policies.policies WHERE id = $1`, [q.bound_policy_id])).rows[0];
            throw conflict(`This quote is already bound as policy ${n?.number ?? ''}.`);
          }
          const quote = toQuote(q);
          if (quote.status === 'expired') throw conflict('This quote has expired; make a new one.');
          const used = await tx.query(`SELECT 1 FROM policies.policies WHERE account_id = $1 AND payment_reference = $2`, [q.account_id, b.payment.reference]);
          if (used.rowCount) throw new AppError('validation_failed', 'This payment reference has already been used for a policy.', [{ code: 'payment_reference_used', field: 'payment.reference', message: 'Already used' }]);

          const pv = (await tx.query<{ catalogue_id: string; document: PlanDocument }>(`SELECT catalogue_id, document FROM plans.plan_versions WHERE id = $1`, [q.plan_version_id])).rows[0]!;
          const cat = (await tx.query<{ document: CatalogueDocument }>(`SELECT document FROM studio.benefit_catalogues WHERE id = $1`, [pv.catalogue_id])).rows[0]!.document;
          const selected = quote.benefits.filter((x) => x.selected);
          let cover;
          try {
            cover = policyCoverage(pv.document, cat, selected.map((x) => x.code), { purchaseDate: todayUtc(), departureDate: q.request.trip.departureDate, returnDate: q.request.trip.returnDate }, quote.plan.term);
          } catch (err) {
            if (err instanceof CoverageError) throw new AppError('validation_failed', err.message, [{ code: 'coverage_timing', field: err.field ?? 'timing', message: err.message }]);
            throw err;
          }
          const seq = Number((await tx.query<{ n: string }>(`SELECT nextval('policies.policy_number_seq') AS n`)).rows[0]!.n);
          const number = policyNumber(new Date().getUTCFullYear(), seq);
          const reviewDays = pv.document.settings.find((s) => s.setting === 'review_period')?.value;
          const snapshot: PolicySnapshot = {
            number,
            quoteId: q.id,
            plan: { planId: quote.plan.planId, code: quote.plan.code, name: quote.plan.name, versionId: quote.plan.versionId, version: quote.plan.version, state: quote.state, term: quote.plan.term },
            ruleSet: quote.ruleSet,
            manuals: quote.manuals,
            disclosure: { version: quote.disclosure!.version, title: quote.disclosure!.title, acknowledgedBy: b.acknowledgement.acknowledgedBy, acknowledgedAt: new Date().toISOString() },
            payment: b.payment,
            purchaser: { name: b.purchaser.name, email: b.purchaser.email ?? null },
            travellers: quote.travellers,
            trip: quote.trip,
            benefits: selected.map((x) => {
              const doc = pv.document.benefits.find((d) => d.code === x.code)!;
              const catB = cat.benefits.find((c) => c.code === x.code)!;
              const c = cover.perBenefit[x.code]!;
              return { code: x.code, name: x.name, group: catB.group, packaging: x.packaging, underwriter: doc.underwriter, limits: benefitLimits(pv.document, cat, x.code), premium: x.premium, coverageStart: c.start, coverageEnd: c.end };
            }),
            premium: { kind: quote.premium!.kind, total: quote.premium!.total, perBenefit: quote.premium!.perBenefit, perTraveller: quote.premium!.perTraveller, basis: quote.premium!.basis },
            purchasedOn: todayUtc(),
            reviewPeriodEndsAt: typeof reviewDays === 'number' ? reviewPeriodEnd(todayUtc(), reviewDays) : null,
            term: cover.term,
            waiver: { applies: quote.waiver.applies, conditions: quote.evaluation.waiver.conditions.map((c) => ({ code: c.code, passed: c.passed, detail: c.detail })) },
            cfar: { offered: quote.cfar.offered, noticePeriod: quote.evaluation.cfar.noticePeriod },
          };
          const policy = (
            await tx.query<{ id: string }>(
              `INSERT INTO policies.policies (number, account_id, quote_id, plan_id, plan_version_id, rule_set_id, state, purchased_on, term_start, term_end, premium_total, payment_reference, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
              [number, q.account_id, q.id, q.plan_id, q.plan_version_id, q.rule_set_id, q.state, snapshot.purchasedOn, cover.term.start, cover.term.end, snapshot.premium.total, b.payment.reference, principal.subject],
            )
          ).rows[0]!;
          await tx.query(`INSERT INTO policies.policy_events (policy_id, account_id, type, actor, actor_name, reason, data) VALUES ($1, $2, 'bound', $3, $4, NULL, $5)`, [policy.id, q.account_id, principal.subject, principal.name, JSON.stringify(snapshot)]);
          for (const t of snapshot.travellers) {
            await tx.query(`INSERT INTO policies.policy_travellers (policy_id, account_id, traveller_id, first_name, last_name, date_of_birth) VALUES ($1, $2, $3, $4, $5, $6)`, [policy.id, q.account_id, t.id, t.firstName, t.lastName, t.dateOfBirth]);
            // The duplicate-cover check reads this register; an annual policy covers its whole term.
            if (t.dateOfBirth) {
              const [start, end] = snapshot.plan.term === 'annual' ? [cover.term.start.slice(0, 10), cover.term.end.slice(0, 10)] : [String(q.request.trip.departureDate), String(q.request.trip.returnDate)];
              await tx.query(`INSERT INTO underwriting.cover_register (first_name, last_name, date_of_birth, policy_ref, trip_start, trip_end, term) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [t.firstName, t.lastName, t.dateOfBirth, number, start, end, snapshot.plan.term]);
            }
          }
          for (const x of snapshot.benefits) {
            await tx.query(
              `INSERT INTO policies.policy_benefits (policy_id, account_id, code, name, benefit_group, underwriter, limits, premium, coverage_start, coverage_end) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [policy.id, q.account_id, x.code, x.name, x.group, x.underwriter, JSON.stringify(x.limits), x.premium, x.coverageStart, x.coverageEnd],
            );
          }
          await tx.query(`UPDATE policies.quotes SET status = 'bound', bound_policy_id = $2, updated_at = now() WHERE id = $1`, [q.id, policy.id]);
          await publishEvent(tx, request.ctx, PolicyBound, { policyId: policy.id, number, quoteId: q.id, planCode: quote.plan.code, state: q.state, premiumTotal: snapshot.premium.total, coverageStart: cover.term.start, coverageEnd: cover.term.end }, { accountId: q.account_id });
          await writeAudit(tx, request.ctx, {
            action: 'policy.bound',
            resourceType: 'policy',
            resourceId: policy.id,
            accountId: q.account_id,
            data: { number, quoteId: q.id, premium: snapshot.premium.total, paymentReference: b.payment.reference, disclosureVersion: b.acknowledgement.disclosureVersion, ruleSet: quote.ruleSet, manuals: quote.manuals },
          });
          return { status: 201, body: await policyView(tx, policy.id) };
        });
      });
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(result.status as 201).send(result.body);
    },
  );

  // ---------------- Policies ----------------

  app.get(
    '/v1/policies',
    {
      config: { tenancy: 'account', permission: 'policies:read' },
      schema: {
        tags: ['Policies'],
        summary: 'Policies you can see, newest first',
        querystring: z.object({ accountId: z.uuid().optional(), status: z.enum(['active', 'cancelled', 'expired']).optional(), q: z.string().trim().min(1).max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }),
        response: { 200: z.object({ items: z.array(PolicySummarySchema) }), ...commonErrors },
      },
    },
    async (request) => {
      const q = request.query;
      const { rows } = await withTx(deps.pool, request.ctx, (tx) =>
        tx.query<{ id: string; number: string; account_id: string; status: 'active' | 'cancelled' | 'expired'; plan_code: string; state: string; purchased_on: string; term_start: string; term_end: string; premium_total: string; travellers: string[] }>(
          `SELECT p.id, p.number, p.account_id, p.status, pl.code AS plan_code, p.state, p.purchased_on::text, to_char(p.term_start, 'YYYY-MM-DD"T"HH24:MI') AS term_start,
                  to_char(p.term_end, 'YYYY-MM-DD"T"HH24:MI') AS term_end, p.premium_total::text,
                  array(SELECT t.first_name || ' ' || t.last_name FROM policies.policy_travellers t WHERE t.policy_id = p.id ORDER BY t.traveller_id) AS travellers
             FROM policies.policies p JOIN plans.plans pl ON pl.id = p.plan_id
            WHERE ($1::uuid IS NULL OR p.account_id = $1) AND ($2::text IS NULL OR p.status = $2)
              AND ($3::text IS NULL OR p.number ILIKE '%' || $3 || '%'
                   OR EXISTS (SELECT 1 FROM policies.policy_travellers t WHERE t.policy_id = p.id AND (t.first_name || ' ' || t.last_name) ILIKE '%' || $3 || '%'))
            ORDER BY p.created_at DESC LIMIT $4`,
          [q.accountId ?? null, q.status ?? null, q.q ?? null, q.limit],
        ),
      );
      return { items: rows.map((r) => ({ id: r.id, number: r.number, accountId: r.account_id, status: r.status, planCode: r.plan_code, state: r.state, purchasedOn: r.purchased_on, coverageStart: r.term_start, coverageEnd: r.term_end, premiumTotal: r.premium_total, travellers: r.travellers })) };
    },
  );

  app.get(
    '/v1/policies/:policyId',
    {
      config: { tenancy: 'account', permission: 'policies:read' },
      schema: {
        tags: ['Policies'],
        summary: 'A policy with its history, now or as it was at a date and time (E05-F01)',
        params: policyParams,
        querystring: z.object({ asOf: z.iso.datetime({ offset: true }).optional() }),
        response: { 200: PolicySchema, ...commonErrors },
      },
    },
    async (request) => withTx(deps.pool, request.ctx, (tx) => policyView(tx, request.params.policyId, request.query.asOf)),
  );

  // ---------------- Cover verification ----------------

  app.post(
    '/v1/policy-verifications',
    {
      config: { tenancy: 'platform', permission: 'cover:verify' },
      schema: {
        tags: ['Policies'],
        summary: 'Verify cover under a policy on a date (E05-F05-S01)',
        description: 'For claims systems: whether the policy was in force on the date and time, with each benefit’s limits and cover dates. Every verification is audited.',
        body: PolicyVerificationRequestSchema,
        response: { 200: PolicyVerificationSchema, ...commonErrors },
      },
    },
    async (request) =>
      withTx(deps.pool, request.ctx, async (tx): Promise<PolicyVerification> => {
        const on = request.body.on.length === 10 ? `${request.body.on}T23:59` : request.body.on;
        const p = (await tx.query<{ id: string; account_id: string; number: string }>(`SELECT id, account_id, number FROM policies.policies WHERE number = $1`, [request.body.policyNumber])).rows[0];
        if (!p) {
          await writeAudit(tx, request.ctx, { action: 'policy.verified', resourceType: 'policy', resourceId: request.body.policyNumber, data: { on, found: false } });
          return { found: false, policyNumber: request.body.policyNumber, status: null, on, inForce: false, benefits: [], travellers: [], plan: null, reasons: ['No policy has this number.'] };
        }
        // The policy as it stands: status from its events, benefits as bound.
        const view = await policyView(tx, p.id);
        const benefits = view.record.benefits.map((b) => ({ code: b.code, name: b.name, underwriter: b.underwriter, limits: b.limits, coverageStart: b.coverageStart, coverageEnd: b.coverageEnd, inForceOnDate: inForce(view.status, { start: b.coverageStart, end: b.coverageEnd }, on) }));
        const reasons: string[] = [];
        if (view.status !== 'active') reasons.push(`The policy is ${view.status}.`);
        if (!benefits.some((b) => b.inForceOnDate) && view.status === 'active') reasons.push(`No benefit’s cover period includes ${on.replace('T', ' ')}.`);
        await writeAudit(tx, request.ctx, { action: 'policy.verified', resourceType: 'policy', resourceId: p.id, accountId: p.account_id, data: { number: p.number, on, inForce: benefits.some((b) => b.inForceOnDate) } });
        return { found: true, policyNumber: p.number, status: view.status, on, inForce: benefits.some((b) => b.inForceOnDate), benefits, travellers: view.record.travellers.map((t) => `${t.firstName} ${t.lastName}`), plan: view.record.plan.code, reasons };
      }),
  );
};
