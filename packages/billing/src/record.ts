import type { CommissionRuleDocument } from '@astra/contracts';
import { clawback, commissionOnCharge } from './commission';
import { fromCents, mulPercent, spread } from './money';

/**
 * The money content of a premium record (E08-F01, E08-F02): the amount spread over benefits, travellers and
 * entities so that every view adds up, with premium tax and commission. Anything that cannot be worked out from
 * configured data becomes an issue and the record is held; nothing is guessed. Design: docs/adr/0013.
 */

export type Arrangement = 'VSC' | 'ABIC' | 'VSC_CLIP';
export type Entity = 'VSC' | 'ABIC' | 'UNASSIGNED';
export const entityOf = (a: Arrangement | null): Entity =>
  a === null ? 'UNASSIGNED' : a === 'ABIC' ? 'ABIC' : 'VSC';

export interface RecordInput {
  /** The signed amount of the transaction in cents: charge minus refund. */
  premiumCents: number;
  benefits: { code: string; arrangement: Arrangement | null; weight: number }[];
  travellers: { id: string; weight: number }[];
  state: string;
  /** Premium tax and fee rate in percent by entity in force on the date; absent when none is loaded. */
  taxRates: Partial<Record<'VSC' | 'ABIC', number>>;
  commission: {
    /** The approved rule for the account on the date; null when it has none. */
    rule: CommissionRuleDocument | null;
    monthPremiumBeforeCents: number;
    monthPolicies: number;
    /** For a refund: the effective rate of the policy's bind record; null when it is not known. */
    originalRatePercent: number | null;
  };
  accountLabel: string;
  date: string;
}

export interface RecordMoney {
  perBenefit: { code: string; premium: string }[];
  perTraveller: { travellerId: string; premium: string }[];
  allocation: {
    entity: Entity;
    arrangement: Arrangement | null;
    premium: string;
    taxRatePercent: number | null;
    tax: string | null;
  }[];
  commission: { amount: string; ratePercent: string; rule: string } | null;
  taxCents: number | null;
  commissionCents: number | null;
  issues: string[];
}

export function buildMoney(i: RecordInput): RecordMoney {
  const issues: string[] = [];
  const perBenefitCents = spread(
    i.premiumCents,
    i.benefits.map((b) => b.weight),
  );
  const perTravellerCents = spread(
    i.premiumCents,
    i.travellers.map((t) => t.weight),
  );

  // Entity allocation follows each benefit's underwriting arrangement.
  const lines = new Map<string, { arrangement: Arrangement | null; cents: number }>();
  i.benefits.forEach((b, k) => {
    const key = b.arrangement ?? 'UNASSIGNED';
    const cur = lines.get(key) ?? { arrangement: b.arrangement, cents: 0 };
    cur.cents += perBenefitCents[k]!;
    lines.set(key, cur);
  });
  if (lines.has('UNASSIGNED') && lines.get('UNASSIGNED')!.cents !== 0)
    issues.push(
      `Benefit ${i.benefits
        .filter((b) => b.arrangement === null)
        .map((b) => b.code)
        .join(
          ', ',
        )} has no underwriting arrangement, so its premium cannot be allocated to an entity.`,
    );

  let taxSum = 0;
  let taxComplete = true;
  const allocation = [...lines.values()].map((l) => {
    const entity = entityOf(l.arrangement);
    const rate = entity === 'UNASSIGNED' ? undefined : i.taxRates[entity];
    let tax: number | null;
    if (l.cents === 0) tax = 0;
    else if (rate === undefined) {
      tax = null;
      taxComplete = false;
      if (entity !== 'UNASSIGNED')
        issues.push(`No premium tax rate is loaded for ${i.state} and ${entity} on ${i.date}.`);
    } else tax = mulPercent(l.cents, rate);
    if (tax !== null) taxSum += tax;
    return {
      entity,
      arrangement: l.arrangement,
      premium: fromCents(l.cents),
      taxRatePercent: rate ?? null,
      tax: tax === null ? null : fromCents(tax),
    };
  });
  const taxCents = taxComplete ? taxSum : null;

  // Commission: by the account's rule on a charge, clawed back at the original rate on a refund.
  let commission: RecordMoney['commission'] = null;
  let commissionCents: number | null = null;
  if (i.premiumCents === 0) {
    commission = { amount: '0.00', ratePercent: '0.0000', rule: 'No premium moved' };
    commissionCents = 0;
  } else if (i.premiumCents > 0) {
    if (!i.commission.rule)
      issues.push(
        `${i.accountLabel} has no approved commission rule on ${i.date}. Approve one (or one that pays none) and recalculate.`,
      );
    else {
      const r = commissionOnCharge(i.commission.rule, {
        premiumCents: i.premiumCents,
        monthPremiumBeforeCents: i.commission.monthPremiumBeforeCents,
        monthPolicies: i.commission.monthPolicies,
      });
      commissionCents = r.cents;
      commission = { amount: fromCents(r.cents), ratePercent: r.ratePercent, rule: r.rule };
    }
  } else if (i.commission.originalRatePercent === null) {
    issues.push(
      'The commission earned on the original premium is not known, so the clawback cannot be calculated.',
    );
  } else {
    commissionCents = clawback(i.premiumCents, i.commission.originalRatePercent);
    commission = {
      amount: fromCents(commissionCents),
      ratePercent: i.commission.originalRatePercent.toFixed(4),
      rule: 'Clawback at the rate earned on the original premium',
    };
  }

  return {
    perBenefit: i.benefits.map((b, k) => ({
      code: b.code,
      premium: fromCents(perBenefitCents[k]!),
    })),
    perTraveller: i.travellers.map((t, k) => ({
      travellerId: t.id,
      premium: fromCents(perTravellerCents[k]!),
    })),
    allocation,
    commission,
    taxCents,
    commissionCents,
    issues,
  };
}
