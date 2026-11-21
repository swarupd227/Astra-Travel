import type { CoverVerification, EligibilityAnswer, PaymentCondition } from '@astra/contracts';
import { AppError, notFound, type Tx } from '@astra/platform';
import { looksLikeCardNumber } from './parser';

/**
 * Card-linked cover answers (E21-F02-S02, E21-F03-S01): whether an account was eligible on a date, which
 * feed version supports that answer, and whether a trip is covered under the programme's conditions.
 */

export interface ProgrammeForCover {
  id: string;
  account_id: string;
  code: string;
  name: string;
  status: string;
  states: string[];
  effective_from: string;
  effective_to: string | null;
  payment_condition: PaymentCondition;
  eligibility_rule: 'purchase_date' | 'purchase_and_loss_date';
  policy_number: string;
  underwriter: string;
  policy_status: string;
  policy_from: string;
  policy_to: string | null;
}

export function assertNotCardNumber(accountRef: string): void {
  if (looksLikeCardNumber(accountRef)) {
    throw new AppError(
      'validation_failed',
      'Send the issuer account reference, never a card number.',
      [
        {
          field: 'accountRef',
          code: 'invalid',
          message: 'This looks like a card number. Use the issuer token instead.',
        },
      ],
    );
  }
}

const within = (date: string, from: string, to: string | null) =>
  date >= from && (to === null || date < to);

/** Whether the programme (and its master policy) provided cover on the date. Live and suspended
 * programmes both honour accounts that were eligible before suspension; closed and draft do not. */
export function programmeInForce(p: ProgrammeForCover, date: string): boolean {
  return (
    (p.status === 'live' || p.status === 'suspended') &&
    within(date, p.effective_from, p.effective_to) &&
    p.policy_status === 'active' &&
    within(date, p.policy_from, p.policy_to)
  );
}

export async function loadProgrammeByCode(tx: Tx, code: string): Promise<ProgrammeForCover> {
  const { rows } = await tx.query<ProgrammeForCover>(
    `SELECT p.id, p.account_id, p.code, p.name, p.status, p.states, p.effective_from, p.effective_to,
            p.payment_condition, p.eligibility_rule, m.policy_number, m.underwriter, m.status AS policy_status,
            m.effective_from AS policy_from, m.effective_to AS policy_to
       FROM card.programmes p JOIN card.master_policies m ON m.id = p.master_policy_id
      WHERE p.code = $1`,
    [code],
  );
  if (!rows[0]) throw notFound('The card programme');
  return rows[0];
}

export async function loadProgrammeById(tx: Tx, id: string): Promise<ProgrammeForCover> {
  const { rows } = await tx.query<{ code: string }>(
    `SELECT code FROM card.programmes WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('The card programme');
  return loadProgrammeByCode(tx, rows[0].code);
}

/** Answers from the ledger: the period that covers the date, and the feed that established it. */
export async function eligibilityOn(
  tx: Tx,
  programme: ProgrammeForCover,
  accountRef: string,
  date: string,
): Promise<EligibilityAnswer> {
  const { rows } = await tx.query<{
    product_code: string;
    valid_from: string;
    valid_to: string | null;
    feed_id: string;
    sequence: number | null;
    as_of_date: string | null;
  }>(
    `SELECT e.product_code, e.valid_from, e.valid_to, f.id AS feed_id, f.sequence, f.as_of_date
       FROM card.eligibility_periods e JOIN card.feeds f ON f.id = e.established_by
      WHERE e.programme_id = $1 AND e.account_ref = $2
        AND e.valid_from <= $3::date AND (e.valid_to IS NULL OR e.valid_to > $3::date)
      ORDER BY e.id DESC LIMIT 1`,
    [programme.id, accountRef, date],
  );
  const r = rows[0];
  return {
    date,
    eligible: Boolean(r),
    productCode: r?.product_code ?? null,
    // Stored ends are exclusive; answers give the last eligible day.
    period: r ? { from: r.valid_from, to: r.valid_to ? addDays(r.valid_to, -1) : null } : null,
    supportedByFeed: r ? { id: r.feed_id, sequence: r.sequence, asOfDate: r.as_of_date } : null,
    programmeInForce: programmeInForce(programme, date),
  };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function evaluatePayment(
  rule: PaymentCondition,
  payment: { tripCost: number; amountPaidWithAccount: number } | undefined,
): { met: boolean | null; explanation: string } {
  if (rule.rule === 'none')
    return { met: true, explanation: 'This programme has no payment condition.' };
  const need = rule.rule === 'full' ? 100 : rule.minimumPercent;
  const describe =
    rule.rule === 'full' ? 'the full trip cost' : `at least ${need}% of the trip cost`;
  if (!payment)
    return {
      met: null,
      explanation: `Cover requires ${describe} to be paid with the account; no payment details were given.`,
    };
  if (payment.amountPaidWithAccount > payment.tripCost) {
    throw new AppError(
      'validation_failed',
      'The amount paid with the account cannot exceed the trip cost.',
      [
        {
          field: 'payment.amountPaidWithAccount',
          code: 'invalid',
          message: 'Must not exceed the trip cost',
        },
      ],
    );
  }
  // Compare in cents to avoid floating-point surprises at the boundary.
  const paidCents = Math.round(payment.amountPaidWithAccount * 100);
  const costCents = Math.round(payment.tripCost * 100);
  const met = paidCents * 100 >= costCents * need;
  const pct = costCents === 0 ? 0 : Math.floor((paidCents * 10000) / costCents) / 100;
  return {
    met,
    explanation: met
      ? `${pct}% of the trip cost was paid with the account; the programme requires ${describe}.`
      : `Only ${pct}% of the trip cost was paid with the account; the programme requires ${describe}.`,
  };
}

export async function verifyCover(
  tx: Tx,
  request: {
    programmeCode: string;
    accountRef: string;
    purchaseDate: string;
    lossDate: string;
    payment?: { tripCost: number; amountPaidWithAccount: number } | undefined;
  },
): Promise<CoverVerification> {
  assertNotCardNumber(request.accountRef);
  if (request.lossDate < request.purchaseDate) {
    throw new AppError('validation_failed', 'The loss date cannot be before the purchase date.', [
      { field: 'lossDate', code: 'invalid', message: 'Must be on or after the purchase date' },
    ]);
  }
  const p = await loadProgrammeByCode(tx, request.programmeCode);
  const onPurchaseDate = await eligibilityOn(tx, p, request.accountRef, request.purchaseDate);
  const onLossDate = await eligibilityOn(tx, p, request.accountRef, request.lossDate);
  const payment = evaluatePayment(p.payment_condition, request.payment);
  const cert = await tx.query<{ certificate_number: string }>(
    `SELECT certificate_number FROM card.certificates WHERE programme_id = $1 AND account_ref = $2`,
    [p.id, request.accountRef],
  );

  const reasons: string[] = [];
  if (!onPurchaseDate.programmeInForce)
    reasons.push(`The programme was not in force on the purchase date (${request.purchaseDate}).`);
  if (!onPurchaseDate.eligible)
    reasons.push(`The account was not eligible on the purchase date (${request.purchaseDate}).`);
  if (p.eligibility_rule === 'purchase_and_loss_date') {
    if (!onLossDate.eligible)
      reasons.push(
        `The programme requires eligibility on the loss date too, and the account was not eligible on ${request.lossDate}.`,
      );
  }
  if (payment.met === false) reasons.push(payment.explanation);
  if (payment.met === null) reasons.push(payment.explanation);

  return {
    covered: reasons.length === 0,
    reasons,
    certificateNumber: cert.rows[0]?.certificate_number ?? null,
    programme: { id: p.id, code: p.code, name: p.name, status: p.status },
    masterPolicy: { policyNumber: p.policy_number, underwriter: p.underwriter },
    states: p.states,
    onPurchaseDate,
    onLossDate,
    paymentCondition: {
      rule: p.payment_condition,
      met: payment.met,
      explanation: payment.explanation,
    },
    checkedAt: new Date().toISOString(),
  };
}
