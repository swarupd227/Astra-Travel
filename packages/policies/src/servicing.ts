import type { PolicySnapshot, ServicingRules } from '@astra/contracts';
import { addDays } from './coverage';

/**
 * The money rules of servicing (E06-F01, E06-F02), as pure functions of the policy, the plan's servicing
 * rules and the moment. Amounts are whole cents. Design: docs/adr/0012.
 */

export const toCents = (s: string): number => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Not an amount: ${s}`);
  const c = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] ? -c : c;
};
export const fromCents = (c: number): string => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

const minutes = (local: string) => Date.parse(`${local}Z`) / 60_000;

export interface ReviewStatus {
  inReview: boolean;
  /** When the review period ends: the filed period's end, or the start of the departure date if that is sooner. */
  endsAt: string | null;
}

/** The review period runs from purchase to its end date, and ends automatically at departure (E06-F01-S01). */
export function reviewStatus(s: Pick<PolicySnapshot, 'reviewPeriodEndsAt' | 'trip'>, nowLocal: string): ReviewStatus {
  if (!s.reviewPeriodEndsAt) return { inReview: false, endsAt: null };
  const departure = typeof s.trip.departureDate === 'string' ? `${s.trip.departureDate}T00:00` : null;
  const endsAt = departure && departure < s.reviewPeriodEndsAt ? departure : s.reviewPeriodEndsAt;
  return { inReview: nowLocal <= endsAt, endsAt };
}

export interface Money {
  charge: string;
  refund: string;
  retained: string;
  /** In words: what rule applied and why. */
  explanation: string;
  basis: 'review_period' | 'loss_reported' | 'non_refundable' | 'pro_rata' | 'none';
}

/** What a cancellation refunds, from the premium paid. */
export function cancellationMoney(premiumTotal: string, o: { inReview: boolean; noLoss: boolean; rule: ServicingRules['postReviewRefund']; termStart: string; termEnd: string; nowLocal: string }): Money {
  const premium = toCents(premiumTotal);
  const done = (refund: number, basis: Money['basis'], explanation: string): Money => ({ charge: '0.00', refund: fromCents(refund), retained: fromCents(premium - refund), explanation, basis });
  if (o.inReview && o.noLoss) return done(premium, 'review_period', 'Cancelled within the review period before departure with no loss: the full premium is refunded.');
  if (o.inReview) return done(0, 'loss_reported', 'The traveller has had a loss that would lead to a claim, so the review-period refund does not apply; the premium is not refunded.');
  if (o.rule === 'pro_rata') {
    const start = minutes(o.termStart);
    const end = minutes(o.termEnd);
    const from = Math.max(start, minutes(o.nowLocal));
    const left = Math.max(0, end - from) / (end - start);
    const refund = Math.min(premium, Math.round(premium * left));
    return done(refund, 'pro_rata', `The review period has ended. This plan refunds the unexpired part of the term (${Math.round(left * 100)}%).`);
  }
  return done(0, 'non_refundable', 'The review period has ended, and the filed form treats the premium as non-refundable. No state rule for this plan says otherwise.');
}

/** What a change charges or refunds, from the re-rated difference. `lossFree` is false when a loss has been reported. */
export function changeMoney(deltaCents: number, o: { inReview: boolean; rule: ServicingRules['postReviewRefund']; lossFree?: boolean }): Money {
  if (deltaCents === 0) return { charge: '0.00', refund: '0.00', retained: '0.00', explanation: 'The premium does not change.', basis: 'none' };
  if (deltaCents > 0) return { charge: fromCents(deltaCents), refund: '0.00', retained: '0.00', explanation: 'The re-rated premium is higher; the difference is charged.', basis: 'none' };
  const back = -deltaCents;
  if (o.inReview && o.lossFree !== false) return { charge: '0.00', refund: fromCents(back), retained: '0.00', explanation: 'The re-rated premium is lower and the review period is running: the difference is refunded.', basis: 'review_period' };
  if (o.rule === 'pro_rata') return { charge: '0.00', refund: fromCents(back), retained: '0.00', explanation: 'The re-rated premium is lower; this plan refunds the difference.', basis: 'pro_rata' };
  return { charge: '0.00', refund: '0.00', retained: fromCents(back), explanation: 'The re-rated premium is lower, but the review period has ended (or a loss has been reported) and the premium is non-refundable under the filed form, so the difference is kept.', basis: 'non_refundable' };
}

/** Whether a time limit measured in days from purchase still allows the change. A null limit has not been set. */
export function withinDays(purchasedOn: string, today: string, limit: number | null): boolean {
  return limit === null || today <= addDays(purchasedOn, limit);
}
