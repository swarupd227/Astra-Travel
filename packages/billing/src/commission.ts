import type { CommissionRuleDocument } from '@astra/contracts';
import { mulPercent } from './money';

/**
 * Commission on a charge, by the account's rule (E08-F02-S01), and the clawback on a refund. No rule is assumed:
 * the caller holds the record when an account has none.
 */
export interface CommissionContext {
  /** The charge, in cents (positive). */
  premiumCents: number;
  /** What the account has been charged this calendar month, before this charge, in cents. */
  monthPremiumBeforeCents: number;
  /** How many policies the account has sold this month, counting this one if it is a bind. */
  monthPolicies: number;
}

export interface CommissionResult {
  cents: number;
  /** The effective percent of this charge, to four decimals. */
  ratePercent: string;
  rule: string;
}

const pct = (cents: number, premium: number) => (premium === 0 ? '0.0000' : ((cents / premium) * 100).toFixed(4));

export function commissionOnCharge(rule: CommissionRuleDocument, c: CommissionContext): CommissionResult {
  switch (rule.kind) {
    case 'none':
      return { cents: 0, ratePercent: '0.0000', rule: 'No commission' };
    case 'flat': {
      const cents = mulPercent(c.premiumCents, rule.percent);
      return { cents, ratePercent: rule.percent.toFixed(4), rule: `Flat ${rule.percent}%` };
    }
    case 'tiered': {
      // Marginal: each slice of the month's premium earns its own tier's percent.
      let cents = 0;
      let from = c.monthPremiumBeforeCents;
      let left = c.premiumCents;
      let lower = 0;
      for (const tier of rule.tiers) {
        const upper = tier.upTo === null ? Infinity : Math.round(tier.upTo * 100);
        if (from < upper && left > 0) {
          const slice = Math.min(left, upper - Math.max(from, lower));
          if (slice > 0) {
            cents += mulPercent(slice, tier.percent);
            from += slice;
            left -= slice;
          }
        }
        lower = upper;
      }
      return { cents, ratePercent: pct(cents, c.premiumCents), rule: `Tiered by monthly premium (${rule.tiers.length} tiers)` };
    }
    case 'volume': {
      const band = [...rule.bands].reverse().find((b) => c.monthPolicies >= b.minPolicies) ?? rule.bands[0]!;
      return { cents: mulPercent(c.premiumCents, band.percent), ratePercent: band.percent.toFixed(4), rule: `Volume: ${band.percent}% from ${band.minPolicies} policies a month` };
    }
  }
}

/** A refund takes back commission at the rate the original charge earned, so retained premium keeps its own. */
export function clawback(refundCents: number, originalRatePercent: number): number {
  return -mulPercent(Math.abs(refundCents), originalRatePercent);
}
