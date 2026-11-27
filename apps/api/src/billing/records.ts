import type { CommissionRuleDocument, PolicySnapshot } from '@astra/contracts';
import { buildMoney, fromCents, toCents, type Arrangement, type RecordInput } from '@astra/billing';
import { conflict, notFound, type Tx } from '@astra/platform';
import { versionInForce } from '@astra/studio';
import { refundHold } from '../servicing/screening';

/**
 * Creating and recalculating premium records (E08-F01, E08-F02). A record is written in the transaction of the
 * policy event it describes, so a transaction without a record cannot exist. Design: docs/adr/0013.
 */

export interface Transaction {
  kind: 'bind' | 'change' | 'cancellation';
  policy: { id: string; number: string; accountId: string };
  eventSeq: number;
  /** The record before the transaction (null at bind) and after it (the same record for a cancellation). */
  before: PolicySnapshot | null;
  after: PolicySnapshot;
  money: { charge: string; refund: string; retained: string };
  worksheetIds: string[];
}

type Stored = Pick<
  RecordInput,
  'premiumCents' | 'benefits' | 'travellers' | 'state' | 'accountLabel' | 'date'
> & { kind: Transaction['kind']; policyId: string; accountId: string; occurredAt: string };

const utcDate = (d: Date) => d.toISOString().slice(0, 10);

/** What the configured data says on the date: tax rates, the account's commission rule and its month so far. */
async function context(tx: Tx, s: Stored): Promise<RecordInput> {
  const taxRates: RecordInput['taxRates'] = {};
  const v = await versionInForce(tx, 'premium_tax_rates', s.date);
  if (v) {
    const { rows } = await tx.query<{ key: string; data: { ratePercent: number } }>(
      `SELECT key, data FROM refdata.entries WHERE version_id = $1 AND key = ANY ($2::text[])`,
      [v.id, [`${s.state}:VSC`, `${s.state}:ABIC`]],
    );
    for (const r of rows) taxRates[r.key.endsWith(':ABIC') ? 'ABIC' : 'VSC'] = r.data.ratePercent;
  }
  const rule =
    (
      await tx.query<{ document: CommissionRuleDocument }>(
        `SELECT document FROM billing.commission_rules WHERE account_id = $1 AND status = 'approved' AND effective_from <= $2::date ORDER BY effective_from DESC, version DESC LIMIT 1`,
        [s.accountId, s.date],
      )
    ).rows[0]?.document ?? null;
  const month = (
    await tx.query<{ charges: string; binds: string }>(
      `SELECT coalesce(sum(charge_cents), 0)::text AS charges, count(*) FILTER (WHERE type = 'bind')::text AS binds
         FROM billing.premium_records WHERE account_id = $1 AND type IN ('bind', 'change') AND occurred_at >= date_trunc('month', $2::timestamptz) AND occurred_at < $2::timestamptz`,
      [s.accountId, s.occurredAt],
    )
  ).rows[0]!;
  let original: number | null = null;
  if (s.premiumCents < 0) {
    const bind = (
      await tx.query<{ commission: { ratePercent: string } | null }>(
        `SELECT commission FROM billing.premium_records WHERE policy_id = $1 AND type = 'bind'`,
        [s.policyId],
      )
    ).rows[0];
    original = bind?.commission ? Number(bind.commission.ratePercent) : null;
  }
  return {
    premiumCents: s.premiumCents,
    benefits: s.benefits,
    travellers: s.travellers,
    state: s.state,
    taxRates,
    commission: {
      rule,
      monthPremiumBeforeCents: Number(month.charges),
      monthPolicies: Number(month.binds) + (s.kind === 'bind' ? 1 : 0),
      originalRatePercent: original,
    },
    accountLabel: s.accountLabel,
    date: s.date,
  };
}

const cents = (v: string | null | undefined) => (v ? toCents(v) : 0);

/** Weights for the spread: the premium of each benefit and traveller, or for a change how much each moved. */
function weights(t: Transaction): {
  benefits: Stored['benefits'];
  travellers: Stored['travellers'];
} {
  const a = t.after;
  const b = t.before;
  const codes = [
    ...new Set([...a.benefits.map((x) => x.code), ...(b?.benefits ?? []).map((x) => x.code)]),
  ];
  const benefits = codes.map((code) => {
    const na = a.benefits.find((x) => x.code === code);
    const nb = b?.benefits.find((x) => x.code === code);
    const w =
      t.kind === 'change'
        ? Math.abs(cents(na?.premium) - cents(nb?.premium))
        : cents((na ?? nb)?.premium);
    return {
      code,
      arrangement: ((na ?? nb)!.underwriter ?? null) as Arrangement | null,
      weight: w,
    };
  });
  const ids = [
    ...new Set([
      ...a.premium.perTraveller.map((x) => x.travellerId),
      ...(b?.premium.perTraveller ?? []).map((x) => x.travellerId),
    ]),
  ];
  const travellers = ids.map((id) => {
    const na = a.premium.perTraveller.find((x) => x.travellerId === id);
    const nb = b?.premium.perTraveller.find((x) => x.travellerId === id);
    return {
      id,
      weight:
        t.kind === 'change'
          ? Math.abs(cents(na?.total) - cents(nb?.total))
          : cents((na ?? nb)?.total),
    };
  });
  return { benefits, travellers };
}

export async function recordTransaction(
  tx: Tx,
  t: Transaction,
  now: Date = new Date(),
): Promise<string | null> {
  const acc = (
    await tx.query<{ name: string; sandbox: boolean }>(
      `SELECT name, sandbox FROM platform.accounts WHERE id = $1`,
      [t.policy.accountId],
    )
  ).rows[0];
  // A sandbox account's transactions are synthetic: they are never billed (docs/adr/0014).
  if (acc?.sandbox) return null;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing:${t.policy.accountId}`]);
  const w = weights(t);
  const charge = toCents(t.money.charge);
  const refund = toCents(t.money.refund);
  const stored: Stored = {
    kind: t.kind,
    policyId: t.policy.id,
    accountId: t.policy.accountId,
    premiumCents: charge - refund,
    benefits: w.benefits,
    travellers: w.travellers,
    state: t.after.plan.state,
    accountLabel: acc?.name ?? 'The account',
    date: utcDate(now),
    occurredAt: now.toISOString(),
  };
  const m = buildMoney(await context(tx, stored));
  // A refund a sanctions match is waiting on is recorded, and not sent to billing until a person clears it.
  if (stored.premiumCents < 0) {
    const hold = await refundHold(tx, t.policy.id);
    if (hold) m.issues.push(hold);
  }
  const seq = Number(
    (await tx.query<{ n: string }>(`SELECT nextval('billing.record_seq') AS n`)).rows[0]!.n,
  );
  const worksheets =
    t.worksheetIds.length || t.kind !== 'cancellation'
      ? t.worksheetIds
      : ((
          await tx.query<{ worksheet_ids: string[] }>(
            `SELECT worksheet_ids FROM billing.premium_records WHERE policy_id = $1 AND type = 'bind'`,
            [t.policy.id],
          )
        ).rows[0]?.worksheet_ids ?? []);
  const row = (
    await tx.query<{ id: string }>(
      `INSERT INTO billing.premium_records
         (number, type, account_id, policy_id, policy_event_seq, state, status, issues, premium_cents, charge_cents, refund_cents, retained_cents, commission_cents, tax_cents,
          per_benefit, per_traveller, allocation, commission, basis, worksheet_ids, inputs, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
      [
        `BR-${now.getUTCFullYear()}-${String(seq).padStart(6, '0')}`,
        t.kind,
        t.policy.accountId,
        t.policy.id,
        t.eventSeq,
        t.after.plan.state,
        m.issues.length ? 'held' : 'ready',
        m.issues,
        stored.premiumCents,
        charge,
        refund,
        toCents(t.money.retained),
        m.commissionCents,
        m.taxCents,
        JSON.stringify(m.perBenefit),
        JSON.stringify(m.perTraveller),
        JSON.stringify(m.allocation),
        m.commission ? JSON.stringify(m.commission) : null,
        JSON.stringify(t.after.premium.basis ?? null),
        worksheets,
        JSON.stringify(stored),
        now.toISOString(),
      ],
    )
  ).rows[0]!;
  return row.id;
}

/** Works a held record out again from what it was made from, with the data configured now, as of the transaction's date (E08-F01). */
export async function recalculate(
  tx: Tx,
  id: string,
): Promise<{ status: 'held' | 'ready'; issues: string[] }> {
  const r = (
    await tx.query<{ status: string; inputs: Stored; account_id: string }>(
      `SELECT status, inputs, account_id FROM billing.premium_records WHERE id = $1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!r) throw notFound('The premium record');
  if (r.status !== 'held')
    throw conflict(`This record is ${r.status}; only a held record is recalculated.`);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing:${r.account_id}`]);
  const m = buildMoney(await context(tx, r.inputs));
  if (r.inputs.premiumCents < 0) {
    const hold = await refundHold(tx, r.inputs.policyId);
    if (hold) m.issues.push(hold);
  }
  const status = m.issues.length ? 'held' : 'ready';
  await tx.query(
    `UPDATE billing.premium_records SET status = $2, issues = $3, per_benefit = $4, per_traveller = $5, allocation = $6, commission = $7, commission_cents = $8, tax_cents = $9 WHERE id = $1`,
    [
      id,
      status,
      m.issues,
      JSON.stringify(m.perBenefit),
      JSON.stringify(m.perTraveller),
      JSON.stringify(m.allocation),
      m.commission ? JSON.stringify(m.commission) : null,
      m.commissionCents,
      m.taxCents,
    ],
  );
  return { status, issues: m.issues };
}

export { fromCents };
