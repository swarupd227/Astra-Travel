import { ServicingRulesSchema, type CatalogueDocument, type PlanDocument, type PolicySnapshot, type ServicingPreview, type ServicingRequest } from '@astra/contracts';
import { diffRecords } from '@astra/documents';
import { AppError, conflict, notFound, type RequestContext, type Tx } from '@astra/platform';
import { benefitLimits, cancellationMoney, changeMoney, CoverageError, fromCents, policyCoverage, project, reviewStatus, toCents, withinDays, type Money } from '@astra/policies';
import { loadEvents } from '../documents/issue';
import { buildQuote, type NormalisedQuoteRequest, type Pinned } from '../routes/quote-core';

/**
 * The servicing engine (E06): works out what a request would do to a policy, without writing anything, so
 * that the same result can be shown to the person and then applied. Design: docs/adr/0012.
 */

export interface Planned {
  preview: ServicingPreview;
  policy: { id: string; number: string; accountId: string; planVersionId: string; status: string };
  before: PolicySnapshot;
  /** The new record, for a change that is allowed; null for a cancellation or when not allowed. */
  after: PolicySnapshot | null;
  /** The top-level record keys the change replaces. */
  patch: Record<string, unknown> | null;
  money: Money;
  /** For a cancellation: the status the policy goes to. */
  cancel: { noLoss: boolean } | null;
  /** Whether the travellers or benefits tables must be rewritten. */
  rewrite: boolean;
}

const labelOf: Record<string, string> = {
  'trip.departureDate': 'Departure date',
  'trip.returnDate': 'Return date',
  'trip.supplier': 'Supplier',
  'premium.total': 'Total premium',
  'term.start': 'Cover starts',
  'term.end': 'Cover ends',
};
const pretty = (path: string) =>
  labelOf[path] ??
  path
    .replace(/^benefits\.([^.]+)\.(.*)$/, (_m, code: string, rest: string) => `${code.replace(/_/g, ' ')}: ${rest}`)
    .replace(/^travellers\.([^.]+)\.(.*)$/, (_m, id: string, rest: string) => `Traveller ${id}: ${rest}`)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\./g, ' › ');

const REFUSED = (problems: string[]): string[] => problems;

export async function planServicing(tx: Tx, ctx: RequestContext, policyId: string, req: ServicingRequest, now: Date, lock: boolean): Promise<Planned> {
  const pol = (
    await tx.query<{ id: string; number: string; account_id: string; plan_version_id: string; status: string; quote_id: string }>(
      `SELECT id, number, account_id, plan_version_id, status, quote_id FROM policies.policies WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [policyId],
    )
  ).rows[0];
  if (!pol) throw notFound('The policy');
  if (pol.status !== 'active') throw conflict(`This policy is ${pol.status}; only an active policy can be serviced.`);
  const events = await loadEvents(tx, policyId);
  const before = project(events)!.record;
  const nowLocal = now.toISOString().slice(0, 16);
  const today = nowLocal.slice(0, 10);

  const pv = (await tx.query<{ catalogue_id: string; document: PlanDocument }>(`SELECT catalogue_id, document FROM plans.plan_versions WHERE id = $1`, [pol.plan_version_id])).rows[0]!;
  // A plan version saved before servicing rules existed has none: the filed sample form's rule applies.
  const rules = ServicingRulesSchema.parse(pv.document.servicing ?? {});
  const review = reviewStatus(before, nowLocal);
  const policy = { id: pol.id, number: pol.number, accountId: pol.account_id, planVersionId: pol.plan_version_id, status: pol.status };
  const noMoney: Money = { charge: '0.00', refund: '0.00', retained: '0.00', explanation: 'The premium does not change.', basis: 'none' };

  const refuse = (problems: string[], summary: string): Planned => ({
    preview: { type: req.type, allowed: false, problems: REFUSED(problems), summary, changes: [], premium: null, money: { charge: '0.00', refund: '0.00', retained: '0.00', explanation: noMoney.explanation }, reviewPeriod: { inReview: review.inReview, endsAt: review.endsAt }, confirmAmount: '0.00' },
    policy,
    before,
    after: null,
    patch: null,
    money: noMoney,
    cancel: null,
    rewrite: false,
  });

  // ---- Cancellation: no re-rating, only what is refunded.
  if (req.type === 'cancel') {
    const money = cancellationMoney(before.premium.total, { inReview: review.inReview, noLoss: req.noLoss, rule: rules.postReviewRefund, termStart: before.term.start, termEnd: before.term.end, nowLocal });
    return {
      preview: {
        type: 'cancel',
        allowed: true,
        problems: [],
        summary: `Cancel ${before.number}. ${money.explanation}`,
        changes: [{ what: 'Status', before: 'Active', after: 'Cancelled' }],
        premium: { before: before.premium.total, after: '0.00', delta: fromCents(-toCents(before.premium.total)) },
        money: { charge: money.charge, refund: money.refund, retained: money.retained, explanation: money.explanation },
        reviewPeriod: { inReview: review.inReview, endsAt: review.endsAt },
        confirmAmount: money.refund,
      },
      policy,
      before,
      after: null,
      patch: null,
      money,
      cancel: { noLoss: req.noLoss },
      rewrite: false,
    };
  }

  // ---- The request as it stands now, from the current record.
  const q = (await tx.query<{ request: NormalisedQuoteRequest }>(`SELECT request FROM policies.quotes WHERE id = $1`, [pol.quote_id])).rows[0]!.request;
  const { tripDays: _days, ...trip } = before.trip as Record<string, unknown> & { tripDays?: unknown };
  const base: NormalisedQuoteRequest = {
    accountId: pol.account_id,
    planCode: before.plan.code,
    state: before.plan.state,
    travellers: before.travellers.map((t) => ({ id: t.id, firstName: t.firstName, lastName: t.lastName, dateOfBirth: t.dateOfBirth ?? undefined, age: t.age ?? undefined, costPerTraveller: t.costPerTraveller })),
    trip: { ...(trip as NormalisedQuoteRequest['trip']), purchaseDate: before.purchasedOn },
    insuredPercent: q.insuredPercent,
    businessSegment: q.businessSegment,
    selection: before.benefits.filter((b) => b.packaging !== 'packaged').map((b) => b.code),
    ...(q.billingBasis ? { billingBasis: q.billingBasis } : {}),
  };
  const next: NormalisedQuoteRequest = structuredClone(base);
  const problems: string[] = [];
  let lossFree = true;
  let rerate = true;
  let purchaser: PolicySnapshot['purchaser'] = before.purchaser;
  let summary = '';

  switch (req.type) {
    case 'change_dates': {
      if (String(before.trip.departureDate) <= today) problems.push('The trip has already started, so its dates cannot be changed.');
      if (req.departureDate < today) problems.push('The new departure date is in the past.');
      if (req.returnDate < req.departureDate) problems.push('The return date is before the departure date.');
      next.trip = { ...next.trip, departureDate: req.departureDate, returnDate: req.returnDate };
      summary = `Move the trip to ${req.departureDate} – ${req.returnDate}.`;
      break;
    }
    case 'change_cost': {
      const raised = req.costs.some((c) => toCents(c.costPerTraveller) > toCents(base.travellers.find((t) => t.id === c.travellerId)?.costPerTraveller ?? '0'));
      for (const c of req.costs) if (!base.travellers.some((t) => t.id === c.travellerId)) problems.push(`There is no traveller ${c.travellerId} on the policy.`);
      if (raised && !withinDays(before.purchasedOn, today, rules.additionalCostDays)) problems.push(`More trip cost can be insured only within ${rules.additionalCostDays} days of purchase.`);
      next.travellers = next.travellers.map((t) => ({ ...t, costPerTraveller: req.costs.find((c) => c.travellerId === t.id)?.costPerTraveller ?? t.costPerTraveller }));
      if (req.insuredPercent !== undefined) next.insuredPercent = req.insuredPercent;
      summary = `Change the insured trip cost of ${req.costs.map((c) => `${c.travellerId} to ${c.costPerTraveller}`).join(', ')}.`;
      break;
    }
    case 'add_traveller': {
      const n = base.travellers.reduce((m, t) => Math.max(m, Number(t.id.replace(/\D/g, '')) || 0), 0) + 1;
      if (base.travellers.length >= 20) problems.push('A policy can have at most 20 travellers.');
      next.travellers = [...next.travellers, { id: `T${n}`, firstName: req.traveller.firstName, lastName: req.traveller.lastName, dateOfBirth: req.traveller.dateOfBirth, age: req.traveller.age, costPerTraveller: req.traveller.costPerTraveller }];
      summary = `Add ${req.traveller.firstName} ${req.traveller.lastName} to the policy.`;
      break;
    }
    case 'remove_traveller': {
      const t = base.travellers.find((x) => x.id === req.travellerId);
      if (!t) problems.push(`There is no traveller ${req.travellerId} on the policy.`);
      else if (base.travellers.length === 1) problems.push('This is the only traveller; cancel the policy instead.');
      next.travellers = next.travellers.filter((x) => x.id !== req.travellerId);
      lossFree = req.noLoss;
      summary = `Remove ${t ? `${t.firstName} ${t.lastName}` : req.travellerId} from the policy.`;
      break;
    }
    case 'change_destinations': {
      next.trip = { ...next.trip, destinations: req.destinations };
      summary = `Change the destinations to ${req.destinations.map((d) => [d.region, d.country].filter(Boolean).join(' / ')).join('; ')}.`;
      break;
    }
    case 'add_benefits': {
      const optional = pv.document.benefits.filter((b) => b.packaging !== 'packaged');
      for (const c of req.benefits) {
        if (!optional.some((b) => b.code === c)) problems.push(`${c} is not an optional benefit of this plan.`);
        else if (before.benefits.some((b) => b.code === c)) problems.push(`${c} is already on the policy.`);
      }
      if (!withinDays(before.purchasedOn, today, rules.addBenefitDays)) problems.push(`Benefits can be added only within ${rules.addBenefitDays} days of purchase.`);
      next.selection = [...new Set([...base.selection, ...req.benefits])];
      summary = `Add ${req.benefits.join(', ')}.`;
      break;
    }
    case 'correct': {
      const dobChanged = req.travellers.some((c) => c.dateOfBirth !== undefined);
      for (const c of req.travellers) if (!base.travellers.some((t) => t.id === c.travellerId)) problems.push(`There is no traveller ${c.travellerId} on the policy.`);
      next.travellers = next.travellers.map((t) => {
        const c = req.travellers.find((x) => x.travellerId === t.id);
        return c ? { ...t, firstName: c.firstName ?? t.firstName, lastName: c.lastName ?? t.lastName, ...(c.dateOfBirth ? { dateOfBirth: c.dateOfBirth, age: undefined } : {}) } : t;
      });
      if (req.supplier !== undefined) next.trip = { ...next.trip, supplier: req.supplier };
      if (req.purchaser) purchaser = { name: req.purchaser.name ?? before.purchaser.name, email: req.purchaser.email ?? before.purchaser.email };
      rerate = dobChanged;
      summary = 'Correct the record.';
      break;
    }
  }
  if (problems.length) return refuse(problems, summary);

  // ---- Re-rate and re-screen with the versions the policy was bound with.
  let after: PolicySnapshot;
  let patch: Record<string, unknown>;
  if (rerate) {
    const pinned: Pinned = { planVersionId: pol.plan_version_id, ruleSetId: before.ruleSet.id, manuals: Object.fromEntries(Object.entries(before.manuals).map(([b, m]) => [b, m.id])) };
    await tx.query(`SELECT set_config('app.ignore_cover_ref', $1, true)`, [pol.number]);
    let built: Awaited<ReturnType<typeof buildQuote>>;
    try {
      built = await buildQuote(tx, ctx, next, 30, pinned);
    } catch (err) {
      if (err instanceof AppError && err.code !== 'not_found') return refuse(err.errors?.length ? err.errors.map((e) => e.message) : [err.message], summary);
      throw err;
    } finally {
      await tx.query(`SELECT set_config('app.ignore_cover_ref', '', true)`);
    }
    const b = built.body;
    const stop: string[] = [];
    if (b.outcome !== 'eligible') stop.push(b.outcome === 'ineligible' ? `Not eligible: ${b.reasons.join(' ')}` : b.outcome === 'held' ? 'A possible sanctions match must be reviewed, so this change cannot be made here.' : 'An underwriter must review this change, so it cannot be made here.');
    if (before.waiver.applies && !b.waiver.applies) stop.push('This change would lose the pre-existing condition waiver the policy was sold with.');
    if (before.cfar.offered && !b.cfar.offered && before.benefits.some((x) => pv.document.benefits.find((d) => d.code === x.code)?.ratingBenefit === 'CFAR')) stop.push('This change would lose eligibility for Cancel For Any Reason.');
    if (!b.premium || b.premium.kind !== 'premium') stop.push('The re-rated price is not a premium that can be charged.');
    if (stop.length) return refuse(stop, summary);

    const cat = (await tx.query<{ document: CatalogueDocument }>(`SELECT document FROM studio.benefit_catalogues WHERE id = $1`, [pv.catalogue_id])).rows[0]!.document;
    const selected = b.benefits.filter((x) => x.selected);
    let cover: ReturnType<typeof policyCoverage>;
    try {
      cover = policyCoverage(pv.document, cat, selected.map((x) => x.code), { purchaseDate: before.purchasedOn, departureDate: String(next.trip.departureDate), returnDate: String(next.trip.returnDate) }, before.plan.term);
    } catch (err) {
      if (err instanceof CoverageError) return refuse([err.message], summary);
      throw err;
    }
    patch = {
      travellers: b.travellers,
      trip: b.trip,
      benefits: selected.map((x) => {
        const doc = pv.document.benefits.find((d) => d.code === x.code)!;
        const catB = cat.benefits.find((c) => c.code === x.code)!;
        const c = cover.perBenefit[x.code]!;
        return { code: x.code, name: x.name, group: catB.group, packaging: x.packaging, underwriter: doc.underwriter, limits: benefitLimits(pv.document, cat, x.code), premium: x.premium, coverageStart: c.start, coverageEnd: c.end };
      }),
      premium: { kind: b.premium!.kind, total: b.premium!.total, perBenefit: b.premium!.perBenefit, perTraveller: b.premium!.perTraveller, basis: b.premium!.basis },
      term: cover.term,
      waiver: { applies: b.waiver.applies, conditions: b.evaluation.waiver.conditions.map((c) => ({ code: c.code, passed: c.passed, detail: c.detail })) },
      cfar: { offered: b.cfar.offered, noticePeriod: b.evaluation.cfar.noticePeriod },
      ...(req.type === 'correct' ? { purchaser } : {}),
    };
    after = { ...before, ...patch } as PolicySnapshot;
  } else {
    const t = next.travellers.map((x) => ({ id: x.id, firstName: x.firstName, lastName: x.lastName, dateOfBirth: x.dateOfBirth ?? null, age: x.age ?? null, costPerTraveller: x.costPerTraveller }));
    patch = { travellers: t, trip: { ...before.trip, ...(next.trip.supplier !== undefined ? { supplier: next.trip.supplier } : {}) }, purchaser };
    after = { ...before, ...patch } as PolicySnapshot;
  }

  const delta = toCents(after.premium.total) - toCents(before.premium.total);
  const money = changeMoney(delta, { inReview: review.inReview, rule: rules.postReviewRefund, lossFree });
  const changes = diffRecords(before, after).map((c) => ({ what: pretty(c.path), before: c.before, after: c.after }));
  return {
    preview: {
      type: req.type,
      allowed: true,
      problems: [],
      summary,
      changes,
      premium: { before: before.premium.total, after: after.premium.total, delta: fromCents(delta) },
      money: { charge: money.charge, refund: money.refund, retained: money.retained, explanation: money.explanation },
      reviewPeriod: { inReview: review.inReview, endsAt: review.endsAt },
      confirmAmount: fromCents(delta),
    },
    policy,
    before,
    after,
    patch,
    money,
    cancel: null,
    rewrite: rerate || req.type === 'correct',
  };
}
