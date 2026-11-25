import Decimal from 'decimal.js';
import {
  EvaluationInputSchema,
  type CatalogueDocument,
  type CreateQuoteRequest,
  type Disclosure,
  type EvaluationResult,
  type PlanDocument,
  type Quote,
  type QuoteRatingRequest,
} from '@astra/contracts';
import { AppError, notFound, preconditionFailed, type RequestContext, type Tx } from '@astra/platform';
import { CoverageError, policyCoverage } from '@astra/policies';
import { planToQuote } from '@astra/plans';
import { QuoteRatingError, rateQuote, RatingError, type ManualForRating } from '@astra/rating';
import { versionInForce } from '@astra/studio';
import { runEvaluation } from './underwriting-evaluate';
import { notCollectedFor, salesAllowed, segmentOn } from '../accounts/config';

/**
 * Builds a quote (E04-F01): the published plan version, rule set and manuals in effect, eligibility, the
 * rating of every selected benefit for every traveller, cover dates and the state disclosure. Used to create
 * a quote, to re-rate it when the selection changes, and by bind. Design: docs/adr/0010.
 */

export interface QuoteTraveller {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  age: number | null;
  costPerTraveller: string;
}

/** The request as stored: travellers numbered, the purchase date set. */
export interface NormalisedQuoteRequest extends Omit<CreateQuoteRequest, 'travellers' | 'trip'> {
  travellers: (Omit<QuoteTraveller, 'dateOfBirth' | 'age'> & { dateOfBirth?: string | undefined; age?: number | undefined })[];
  trip: CreateQuoteRequest['trip'] & { purchaseDate: string };
}

/** What a re-rate keeps: the versions the quote was made with. */
export interface Pinned {
  planVersionId: string;
  ruleSetId: string;
  manuals: Record<string, string>;
}

export interface BuiltQuote {
  planId: string;
  planVersionId: string;
  ruleSetId: string;
  manualIds: Record<string, string>;
  body: Omit<Quote, 'id' | 'accountId' | 'status' | 'revision' | 'createdAt' | 'expiresAt'>;
  worksheets: { benefit: string; travellerId: string; manualId: string; inputsHash: string; request: unknown; result: unknown }[];
}

interface PlanRow {
  id: string;
  code: string;
  name: string;
  kind: 'base' | 'state' | 'account';
  term: 'single_trip' | 'annual';
  state: string | null;
  account_id: string | null;
}
interface VersionRow {
  id: string;
  version: number;
  catalogue_id: string;
  document: PlanDocument;
}
interface ManualRow extends ManualForRating {
  code: string;
}

/** Quote reasons that bind turns into a referral instead of a refusal. */
export const REFERRED_REASON = 'An underwriter must review the case before it can be bound.';
export const HELD_REASON = 'A possible sanctions match must be reviewed before it can be bound.';

const problem = (field: string, message: string, code = 'quote') => ({ code, field, message });
const fail = (message: string, errors: { code: string; field: string; message: string }[] = []): never => {
  throw new AppError('validation_failed', message, errors.length ? errors : undefined);
};

export const ageOn = (dob: string, on: string): number => {
  let age = Number(on.slice(0, 4)) - Number(dob.slice(0, 4));
  if (on.slice(5) < dob.slice(5)) age--;
  return age;
};

export function normalise(req: CreateQuoteRequest, today: string): NormalisedQuoteRequest {
  return {
    ...req,
    travellers: req.travellers.map((t, i) => ({ ...t, id: `T${i + 1}` })),
    trip: { ...req.trip, purchaseDate: req.trip.purchaseDate ?? today },
  };
}

export async function disclosureFor(tx: Tx, state: string, date: string): Promise<Disclosure | null> {
  const v = await versionInForce(tx, 'state_disclosures', date);
  if (!v) return null;
  const e = (await tx.query<{ data: { title: string; text: string } }>(`SELECT data FROM refdata.entries WHERE version_id = $1 AND key = $2`, [v.id, state])).rows[0];
  return e ? { version: v.id, state, title: e.data.title, text: e.data.text } : null;
}

/** The region and scope of a destination: as given, else from the destination regions reference data. */
async function regionsFor(tx: Tx, destinations: { country?: string | undefined; region?: string | undefined; days?: number | undefined }[], date: string, tripDays: number) {
  const v = destinations.length ? await versionInForce(tx, 'destination_regions', date) : null;
  const regions = v ? (await tx.query<{ key: string; data: { scope: 'domestic' | 'international'; countries: string[] } }>(`SELECT key, data FROM refdata.entries WHERE version_id = $1`, [v.id])).rows : [];
  const share = Math.max(1, Math.floor(tripDays / Math.max(1, destinations.length)));
  return destinations.map((d) => {
    const byCode = d.region ? regions.find((r) => r.key === d.region) : undefined;
    const byCountry = !d.region && d.country ? regions.find((r) => r.data.countries.includes(d.country!)) : undefined;
    const found = byCode ?? byCountry;
    return { region: d.region ?? found?.key ?? null, scope: found?.data.scope ?? (d.country ? (d.country === 'US' ? ('domestic' as const) : ('international' as const)) : null), days: d.days ?? share };
  });
}

const today = () => new Date().toISOString().slice(0, 10);

export async function buildQuote(
  tx: Tx,
  ctx: RequestContext,
  req: NormalisedQuoteRequest,
  validDays: number,
  pinned?: Pinned,
): Promise<BuiltQuote & { expiresInDays: number }> {
  void ctx;
  const purchaseDate = req.trip.purchaseDate;
  const plan = (await tx.query<PlanRow>(`SELECT id, code, name, kind, term, state, account_id FROM plans.plans WHERE code = $1`, [req.planCode])).rows[0];
  if (!plan || plan.kind === 'base') throw notFound('The plan');
  if (plan.kind === 'account' && plan.account_id !== req.accountId) throw notFound('The plan');
  if (plan.state !== req.state) fail(`Plan ${plan.code} is for ${plan.state}, not ${req.state}.`, [problem('state', `This plan is sold in ${plan.state}.`, 'wrong_state')]);

  const pv = (
    await tx.query<VersionRow>(
      pinned
        ? `SELECT id, version, catalogue_id, document FROM plans.plan_versions WHERE id = $1`
        : `SELECT id, version, catalogue_id, document FROM plans.plan_versions
            WHERE plan_id = $1 AND status = 'published' AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to > $2::date)`,
      pinned ? [pinned.planVersionId] : [plan.id, purchaseDate],
    )
  ).rows[0];
  if (!pv) throw preconditionFailed(`No published version of plan ${plan.code} is in effect on ${purchaseDate}.`);
  const cat = (await tx.query<{ document: CatalogueDocument }>(`SELECT document FROM studio.benefit_catalogues WHERE id = $1`, [pv.catalogue_id])).rows[0]!.document;
  const doc = pv.document;

  // ---- The account: where it may sell, its segment in force and the rating variables it collects (E07).
  if (!pinned) {
    const sale = await salesAllowed(tx, req.accountId, req.state, purchaseDate);
    if (!sale.allowed) fail(sale.reason!, [problem('state', sale.reason!, 'sales_blocked')]);
  }
  const configuredSegment = await segmentOn(tx, req.accountId, purchaseDate);
  if (configuredSegment && req.businessSegment && req.businessSegment !== configuredSegment) {
    fail(`The account’s approved business segment is ${configuredSegment}, not ${req.businessSegment}.`, [problem('businessSegment', `The account’s segment is ${configuredSegment}; the segment is not taken from the request.`, 'segment_mismatch')]);
  }
  const businessSegment = configuredSegment ?? req.businessSegment;
  const notCollected = await notCollectedFor(tx, req.accountId);

  // ---- Selection: packaged benefits are in; optional ones when chosen.
  const optional = doc.benefits.filter((b) => b.packaging !== 'packaged');
  const unknown = req.selection.filter((c) => !optional.some((b) => b.code === c));
  if (unknown.length) fail(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not an optional benefit of this plan.`, unknown.map((c) => problem('selection', `${c} is not an optional benefit of plan ${plan.code}.`, 'unknown_benefit')));
  const selectedCodes = doc.benefits.filter((b) => b.packaging === 'packaged' || req.selection.includes(b.code)).map((b) => b.code);
  const name = (code: string) => cat.benefits.find((b) => b.code === code)?.name ?? code;
  const ratingOf = (code: string) => doc.benefits.find((b) => b.code === code)?.ratingBenefit ?? null;

  // ---- Eligibility at quote.
  const tripDays = Math.round((Date.parse(`${req.trip.returnDate}T00:00:00Z`) - Date.parse(`${req.trip.departureDate}T00:00:00Z`)) / 86_400_000) + 1;
  const total = req.travellers.reduce((a, t) => a.plus(t.costPerTraveller), new Decimal(0));
  const evalInput = EvaluationInputSchema.parse({
    stage: 'quote',
    travellers: req.travellers.map((t) => ({ id: t.id, firstName: t.firstName, lastName: t.lastName, dateOfBirth: t.dateOfBirth, age: t.age, costPerTraveller: t.costPerTraveller })),
    trip: {
      purchaseDate,
      initialDepositDate: req.trip.initialDepositDate,
      departureDate: req.trip.departureDate,
      returnDate: req.trip.returnDate,
      destinations: req.trip.destinations.map((d) => ({ country: d.country, region: d.region })),
      totalTripCost: total.toFixed(2),
    },
    insuredPercent: req.insuredPercent,
    // The price assumes the traveller will confirm they are able to travel; bind requires the confirmation itself.
    ableToTravel: true,
    businessSegment,
    term: plan.term,
    benefits: selectedCodes,
    cfarRequested: selectedCodes.some((c) => ratingOf(c) === 'CFAR'),
  });
  const evaluation: EvaluationResult = await runEvaluation(tx, ctx, { planVersionId: pv.id, ruleSetId: pinned?.ruleSetId, input: evalInput, persist: false });

  // ---- Which optional benefits can be chosen, and why not.
  const availability = (code: string): { available: boolean; reason: string | null } => {
    if (ratingOf(code) === 'CFAR') return { available: evaluation.cfar.offered, reason: evaluation.cfar.offered ? null : evaluation.cfar.reasons.join(' ') || 'Its conditions are not met.' };
    const t = evaluation.benefitAvailability.find((b) => b.benefit === code);
    return t ? { available: t.available, reason: t.available ? null : t.reason } : { available: true, reason: null };
  };
  const refused = selectedCodes.filter((c) => doc.benefits.find((b) => b.code === c)!.packaging !== 'packaged' && !availability(c).available);
  if (refused.length) fail(`${name(refused[0]!)} is not available: ${availability(refused[0]!).reason}`, refused.map((c) => problem('selection', `${name(c)} is not available: ${availability(c).reason}`, 'benefit_unavailable')));

  // ---- Cover dates.
  let coverage: ReturnType<typeof policyCoverage>;
  try {
    coverage = policyCoverage(doc, cat, selectedCodes, { purchaseDate, departureDate: req.trip.departureDate, returnDate: req.trip.returnDate }, plan.term);
  } catch (err) {
    if (err instanceof CoverageError) return fail(err.message, [problem(err.field ?? 'timing', err.message, 'coverage_timing')]);
    throw err;
  }

  // ---- Rating.
  const waiverApplies = evaluation.waiver.applies;
  const quoteInput = planToQuote(doc, cat, req.state, {
    rateDate: purchaseDate,
    travellers: req.travellers.map((t) => ({ id: t.id, age: t.age ?? (t.dateOfBirth ? ageOn(t.dateOfBirth, purchaseDate) : null), preExistingWaived: waiverApplies, costPerTraveller: t.costPerTraveller })),
    trip: {
      purchaseDate,
      departureDate: req.trip.departureDate,
      returnDate: req.trip.returnDate,
      initialDepositDate: req.trip.initialDepositDate ?? null,
      destinations: await regionsFor(tx, req.trip.destinations, purchaseDate, tripDays),
      penaltyDays: req.trip.penaltyDays ?? null,
    },
    account: { businessSegment: businessSegment ?? null, notCollected },
    cfarEligibility: { passed: evaluation.cfar.passed, reference: evaluation.cfar.reference, reasons: evaluation.cfar.reasons },
  });
  const ratedBenefits = new Set(selectedCodes.map(ratingOf).filter((b): b is string => !!b));
  const q: QuoteRatingRequest = { ...quoteInput, benefits: quoteInput.benefits.filter((b) => ratedBenefits.has(b.benefit)), ...(req.billingBasis ? { billingBasis: req.billingBasis } : {}) };
  if (q.benefits.length === 0) fail('None of the selected benefits is priced by a rate manual, so there is nothing to rate.', [problem('selection', 'The plan sets no rating benefit for the benefits chosen.', 'nothing_to_rate')]);

  const manuals = new Map<string, ManualRow>();
  const missing: string[] = [];
  for (const b of q.benefits) {
    if (manuals.has(b.benefit)) continue;
    const pin = pinned?.manuals[b.benefit];
    const row = (
      await tx.query<ManualRow>(
        pin
          ? `SELECT id, code, version, benefit, state, illustrative, document FROM rating.manuals WHERE id = $1`
          : `SELECT id, code, version, benefit, state, illustrative, document FROM rating.manuals
              WHERE state = $1 AND benefit = $2 AND status = 'published' AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to > $3::date)`,
        pin ? [pin] : [req.state, b.benefit, purchaseDate],
      )
    ).rows[0];
    if (row) manuals.set(b.benefit, row);
    else missing.push(b.benefit);
  }
  if (missing.length) fail(`No published rate manual is in effect in ${req.state} on ${purchaseDate} for ${missing.join(', ')}, so the quote cannot be priced.`, missing.map((m) => problem('benefits', `No published ${m} manual is in effect in ${req.state} on ${purchaseDate}.`, 'manual_not_published')));

  let rating: ReturnType<typeof rateQuote>;
  try {
    rating = rateQuote(q, (benefit) => manuals.get(benefit)!);
  } catch (err) {
    if (err instanceof QuoteRatingError) {
      return fail(err.problems.length === 1 ? err.problems[0]!.message : `${err.problems.length} problems: the quote could not be rated.`, err.problems.slice(0, 100).map((p) => problem(p.field ?? p.benefit, p.message, 'rating')));
    }
    if (err instanceof RatingError) return fail(err.message, [problem('quote', err.message, 'rating')]);
    throw err;
  }

  const disclosure = await disclosureFor(tx, req.state, purchaseDate);
  const ruleSetRow = (await tx.query<{ id: string; version: number }>(pinned ? `SELECT id, version FROM underwriting.rule_sets WHERE id = $1` : `SELECT id, version FROM underwriting.rule_sets WHERE plan_id = $1 AND status = 'published' AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to > $2::date)`, pinned ? [pinned.ruleSetId] : [plan.id, purchaseDate])).rows[0]!;

  const perBenefit = new Map(rating.perBenefit.map((b) => [b.benefit, b.total]));
  const benefits: Quote['benefits'] = doc.benefits.map((b) => {
    const a = b.packaging === 'packaged' ? { available: true, reason: null } : availability(b.code);
    const selected = selectedCodes.includes(b.code);
    const c = coverage.perBenefit[b.code];
    return {
      code: b.code,
      name: name(b.code),
      packaging: b.packaging,
      selected,
      available: a.available,
      reason: a.reason,
      premium: selected && b.ratingBenefit ? (perBenefit.get(b.ratingBenefit) ?? null) : null,
      coverageStart: selected && c ? c.start : null,
      coverageEnd: selected && c ? c.end : null,
    };
  });

  const notBindable: string[] = [];
  if (rating.kind !== 'premium') notBindable.push(`The price is a ${rating.kind === 'loss_cost' ? 'loss cost' : 'mix of loss costs and premiums'}, not a premium: no loss cost multiplier is filed, so it cannot be charged or bound.`);
  if (rating.illustrative) notBindable.push('The price uses an illustrative manual (estimated loadings) and is never charged.');
  if (evaluation.outcome !== 'eligible') notBindable.push(evaluation.outcome === 'ineligible' ? `Not eligible: ${evaluation.reasons.join(' ')}` : evaluation.outcome === 'referred' ? REFERRED_REASON : HELD_REASON);
  if (!disclosure) notBindable.push(`No disclosure for ${req.state} is in force on ${purchaseDate}, so the traveller cannot acknowledge it.`);
  if (rating.notRated.length) notBindable.push(...rating.notRated.map((n) => `${n.benefit} was not rated: ${n.reasons.join(' ')}`));

  const manualIds: Record<string, string> = Object.fromEntries([...manuals].map(([b, m]) => [b, m.id]));
  return {
    planId: plan.id,
    planVersionId: pv.id,
    ruleSetId: ruleSetRow.id,
    manualIds,
    expiresInDays: validDays,
    worksheets: rating.lines.map((l) => ({ benefit: l.benefit, travellerId: l.travellerId, manualId: manuals.get(l.benefit)!.id, inputsHash: l.result.inputsHash, request: l.request, result: l.result })),
    body: {
      state: req.state,
      plan: { planId: plan.id, code: plan.code, name: plan.name, versionId: pv.id, version: pv.version, term: plan.term },
      ruleSet: { id: ruleSetRow.id, version: ruleSetRow.version },
      manuals: Object.fromEntries([...manuals].map(([b, m]) => [b, { id: m.id, code: m.code, version: m.version }])),
      travellers: req.travellers.map((t) => ({ id: t.id, firstName: t.firstName, lastName: t.lastName, dateOfBirth: t.dateOfBirth ?? null, age: t.age ?? (t.dateOfBirth ? ageOn(t.dateOfBirth, purchaseDate) : null), costPerTraveller: t.costPerTraveller })),
      trip: { ...req.trip, tripDays },
      selection: req.selection,
      benefits,
      outcome: evaluation.outcome,
      reasons: evaluation.reasons,
      waiver: { applies: evaluation.waiver.applies },
      cfar: { offered: evaluation.cfar.offered, reasons: evaluation.cfar.reasons },
      premium: {
        kind: rating.kind,
        illustrative: rating.illustrative,
        total: rating.policyTotal,
        perBenefit: rating.perBenefit,
        perTraveller: rating.perTraveller,
        basis: rating.basis,
        // Worksheet IDs are filled in when the worksheets are stored.
        lines: rating.lines.map((l) => ({ benefit: l.benefit, travellerId: l.travellerId, amount: l.result.amount, worksheetId: '00000000-0000-4000-8000-000000000000' })),
      },
      disclosure,
      bindable: notBindable.length === 0,
      notBindable,
      evaluation,
    },
  };
}

export const todayUtc = today;
