import Decimal from 'decimal.js';
import type {
  BillingBasis,
  QuoteRatingRequest,
  RatingRequest,
  RatingResult,
} from '@astra/contracts';
import { rate, RatingError, type ManualForRating } from './engine';

/**
 * A quote's rating (E02-F05-S01): every selected benefit for every traveller, each with its own manual and
 * worksheet, totalled per traveller and per policy, and expressed on the account's billing basis
 * (E02-F06-S01). A quote is all or nothing: any rating error is reported, with every other error, and no
 * total is given.
 */

export interface QuoteLine {
  benefit: string;
  travellerId: string;
  result: RatingResult;
  /** The request the line was rated with, so its worksheet can be stored and reproduced. */
  request: RatingRequest;
}

export interface QuoteRatingResult {
  kind: 'premium' | 'loss_cost' | 'mixed';
  illustrative: boolean;
  lines: QuoteLine[];
  /** Benefits not rated, with the reason (for example CFAR when its eligibility rules did not pass). */
  notRated: { benefit: string; reasons: string[] }[];
  perTraveller: { travellerId: string; total: string }[];
  perBenefit: { benefit: string; total: string }[];
  policyTotal: string;
  basis: BasisAmount | null;
}

export interface BasisAmount {
  basis: BillingBasis['basis'];
  amount: string;
  unit: string;
  method: string;
  approved: boolean;
  fixedFeePerPolicy: string | null;
}

export class QuoteRatingError extends Error {
  constructor(
    readonly problems: {
      benefit: string;
      travellerId: string | null;
      field: string | null;
      message: string;
    }[],
  ) {
    super(problems[0]?.message ?? 'The quote could not be rated.');
    this.name = 'QuoteRatingError';
  }
}

export type ManualResolver = (benefit: string) => ManualForRating;

const money = (d: Decimal) => d.toFixed(2, Decimal.ROUND_HALF_UP);

export function rateQuote(q: QuoteRatingRequest, manualFor: ManualResolver): QuoteRatingResult {
  const lines: QuoteLine[] = [];
  const notRated: QuoteRatingResult['notRated'] = [];
  const problems: QuoteRatingError['problems'] = [];

  for (const b of q.benefits) {
    if (b.plan.cfar && !b.cfarEligibility) {
      problems.push({
        benefit: b.benefit,
        travellerId: null,
        field: 'cfarEligibility',
        message: `${b.benefit}: CFAR is rated only with a CFAR eligibility decision.`,
      });
      continue;
    }
    if (b.cfarEligibility && !b.cfarEligibility.passed) {
      notRated.push({
        benefit: b.benefit,
        reasons: b.cfarEligibility.reasons.length
          ? b.cfarEligibility.reasons
          : ['The CFAR eligibility rules did not pass.'],
      });
      continue;
    }
    let manual: ManualForRating;
    try {
      manual = manualFor(b.benefit);
    } catch (err) {
      if (!(err instanceof RatingError)) throw err;
      problems.push({ benefit: b.benefit, travellerId: null, field: null, message: err.message });
      continue;
    }
    for (const t of q.travellers) {
      const request: RatingRequest = {
        state: q.state,
        benefit: b.benefit,
        rateDate: q.rateDate,
        traveller: { age: t.age ?? null, preExistingWaived: t.preExistingWaived ?? null },
        trip:
          t.costPerTraveller !== undefined
            ? { ...q.trip, costPerTraveller: t.costPerTraveller }
            : { ...q.trip, travellers: q.travellers.length },
        account: q.account,
        plan: b.plan,
      };
      if (
        request.trip.costPerTraveller === undefined &&
        request.trip.reservationTotal === undefined
      ) {
        problems.push({
          benefit: b.benefit,
          travellerId: t.id,
          field: 'trip.reservationTotal',
          message: `Traveller ${t.id}: give a cost per traveller or the reservation total.`,
        });
        continue;
      }
      try {
        lines.push({ benefit: b.benefit, travellerId: t.id, result: rate(manual, request), request });
      } catch (err) {
        if (!(err instanceof RatingError)) throw err;
        problems.push({
          benefit: b.benefit,
          travellerId: t.id,
          field: err.field,
          message: `${b.benefit}, traveller ${t.id}: ${err.message}`,
        });
      }
    }
  }
  if (problems.length) throw new QuoteRatingError(problems);

  const sum = (xs: RatingResult[]) => xs.reduce((a, r) => a.plus(r.amount), new Decimal(0));
  const policyTotal = sum(lines.map((l) => l.result));
  const kinds = new Set(lines.map((l) => l.result.kind));
  const totalTripCost = q.travellers.reduce(
    (a, t) => a.plus(t.costPerTraveller ?? 0),
    new Decimal(0),
  );
  return {
    kind:
      kinds.size > 1
        ? 'mixed'
        : ((kinds.values().next().value as 'premium' | 'loss_cost' | undefined) ?? 'premium'),
    illustrative: lines.some((l) => l.result.illustrative),
    lines,
    notRated,
    perTraveller: q.travellers.map((t) => ({
      travellerId: t.id,
      total: money(sum(lines.filter((l) => l.travellerId === t.id).map((l) => l.result))),
    })),
    perBenefit: [...new Set(lines.map((l) => l.benefit))].map((b) => ({
      benefit: b,
      total: money(sum(lines.filter((l) => l.benefit === b).map((l) => l.result))),
    })),
    policyTotal: money(policyTotal),
    basis: q.billingBasis
      ? toBasis(policyTotal, q.billingBasis, {
          totalTripCost: totalTripCost.isZero()
            ? new Decimal(q.trip.reservationTotal ?? 0)
            : totalTripCost,
          tripDays:
            Math.round(
              (Date.parse(`${q.trip.returnDate}T00:00:00Z`) -
                Date.parse(`${q.trip.departureDate}T00:00:00Z`)) /
                86_400_000,
            ) + 1,
          travellers: q.travellers.length,
        })
      : null,
  };
}

/**
 * Expresses a policy premium on a billing basis (E02-F06-S01). A fixed per-policy fee, when the account
 * has one, comes off first and the remainder is expressed on the basis (combinations).
 */
export function toBasis(
  policyPremium: Decimal,
  b: BillingBasis,
  ctx: { totalTripCost: Decimal; tripDays: number; travellers: number },
): BasisAmount {
  const fee = b.fixedFeePerPolicy ? new Decimal(b.fixedFeePerPolicy) : null;
  const rest = fee ? Decimal.max(policyPremium.minus(fee), 0) : policyPremium;
  const out = (amount: Decimal, unit: string, method: string): BasisAmount => ({
    basis: b.basis,
    amount: amount.toFixed(4, Decimal.ROUND_HALF_UP),
    unit,
    method: fee ? `${method}, after a fixed fee of ${money(fee)} per policy` : method,
    approved: !!b.approval,
    fixedFeePerPolicy: fee ? money(fee) : null,
  });
  switch (b.basis) {
    case 'per_policy':
      return out(rest, 'per policy', 'Policy premium');
    case 'per_100_trip_cost':
      if (ctx.totalTripCost.lte(0))
        throw new RatingError(
          'The billing basis is per $100 of trip cost, but the trip cost is not known.',
        );
      return out(
        rest.div(ctx.totalTripCost.div(100)),
        'per $100 of trip cost',
        `Premium divided by the total trip cost (${money(ctx.totalTripCost)}) in hundreds`,
      );
    case 'per_100_limit': {
      if (!b.limit)
        throw new RatingError('The billing basis is per $100 of limit: give the limit.');
      const limit = new Decimal(b.limit);
      return out(
        rest.div(limit.div(100)),
        'per $100 of limit',
        `Premium divided by the limit (${money(limit)}) in hundreds`,
      );
    }
    case 'per_day':
      return out(
        rest.div(ctx.tripDays * ctx.travellers),
        'per traveller per day',
        `Premium divided by ${ctx.tripDays} days and ${ctx.travellers} travellers`,
      );
    case 'fixed_monthly':
      if (!b.expectedPoliciesPerMonth)
        throw new RatingError(
          'The billing basis is fixed monthly: give the expected policies per month from the approved method.',
        );
      return out(
        rest.mul(b.expectedPoliciesPerMonth),
        'per month',
        `Policy premium times ${b.expectedPoliciesPerMonth} expected policies per month`,
      );
  }
}
