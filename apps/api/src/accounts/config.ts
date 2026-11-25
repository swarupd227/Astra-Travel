import type { Onboarding, OnboardingItem, RatingInput } from '@astra/contracts';
import { ONBOARDING_ITEMS, ONBOARDING_LABELS } from '@astra/contracts';
import type { Tx } from '@astra/platform';

/**
 * What an account is configured to do, as the quote, bind and go-live read it (E07). Design: docs/adr/0014.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The business segment in force on a date: the approved change with the latest effective date at or before it. */
export async function segmentOn(tx: Tx, accountId: string, date: string): Promise<string | null> {
  const r = (await tx.query<{ segment: string }>(`SELECT segment FROM onboarding.segment_changes WHERE account_id = $1 AND status = 'approved' AND effective_from <= $2::date ORDER BY effective_from DESC, decided_at DESC LIMIT 1`, [accountId, date])).rows[0];
  return r?.segment ?? null;
}

/** The rating inputs the account does not collect; empty until a rating analyst has decided. */
export async function notCollectedFor(tx: Tx, accountId: string): Promise<RatingInput[]> {
  const r = (await tx.query<{ not_collected: RatingInput[] }>(`SELECT not_collected FROM onboarding.collected_variables WHERE account_id = $1`, [accountId])).rows[0];
  return r?.not_collected ?? [];
}

export interface SalesDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Whether the account may sell in a state on a date. From go-live an account needs an unexpired, unrevoked
 * registration or licence in the state; before it (and for accounts that predate onboarding) nothing is blocked.
 */
export async function salesAllowed(tx: Tx, accountId: string, state: string, date: string): Promise<SalesDecision> {
  const a = (await tx.query<{ licences_enforced: boolean; name: string; sandbox: boolean }>(`SELECT licences_enforced, name, sandbox FROM platform.accounts WHERE id = $1`, [accountId])).rows[0];
  if (!a || !a.licences_enforced || a.sandbox) return { allowed: true, reason: null };
  const live = (await tx.query(`SELECT 1 FROM onboarding.licences WHERE account_id = $1 AND state = $2 AND status = 'active' AND valid_from <= $3::date AND expires_on >= $3::date LIMIT 1`, [accountId, state, date])).rowCount;
  if (live) return { allowed: true, reason: null };
  const last = (await tx.query<{ expires_on: string; status: string }>(`SELECT expires_on::text, status FROM onboarding.licences WHERE account_id = $1 AND state = $2 ORDER BY expires_on DESC LIMIT 1`, [accountId, state])).rows[0];
  return {
    allowed: false,
    reason: last
      ? last.status === 'revoked'
        ? `${a.name} may not sell in ${state}: its registration or licence there was revoked.`
        : `${a.name} may not sell in ${state}: its registration or licence there ${last.expires_on < date ? `expired on ${last.expires_on}` : 'is not yet in force'}.`
      : `${a.name} may not sell in ${state}: it has no registration or licence there.`,
  };
}

/** The onboarding checklist, judged from what is configured (E07-F01-S01). */
export async function onboardingStatus(tx: Tx, accountId: string, now: Date = new Date()): Promise<Onboarding> {
  const acc = (await tx.query<{ status: Onboarding['accountStatus']; sandbox: boolean; live_at: Date | null; twin: string | null }>(
    `SELECT a.status, a.sandbox, a.live_at, (SELECT t.id FROM platform.accounts t WHERE t.sandbox_of = a.id) AS twin FROM platform.accounts a WHERE a.id = $1`,
    [accountId],
  )).rows[0]!;
  const p = (await tx.query<{ contract_reference: string | null; contract_signed_on: string | null; states: string[]; plans: string[]; integration_method: string | null; rate_basis: unknown; settlement: unknown }>(`SELECT contract_reference, contract_signed_on::text, states, plans, integration_method, rate_basis, settlement FROM onboarding.profiles WHERE account_id = $1`, [accountId])).rows[0];
  const today = day(now);
  const states = p?.states ?? [];
  const items: Record<OnboardingItem, { complete: boolean; detail: string }> = {} as never;

  items.contract = p?.contract_reference && p.contract_signed_on ? { complete: true, detail: `${p.contract_reference}, signed ${p.contract_signed_on}` } : { complete: false, detail: 'Give the contract reference and the date it was signed.' };
  items.states = states.length ? { complete: true, detail: states.join(', ') } : { complete: false, detail: 'Choose the states the account sells in.' };

  const licensed = states.length ? (await tx.query<{ state: string }>(`SELECT DISTINCT state FROM onboarding.licences WHERE account_id = $1 AND status = 'active' AND valid_from <= $2::date AND expires_on >= $2::date AND state = ANY ($3::text[])`, [accountId, today, states])).rows.map((r) => r.state) : [];
  const missing = states.filter((s) => !licensed.includes(s));
  items.licences = !states.length ? { complete: false, detail: 'Choose the states first.' } : missing.length ? { complete: false, detail: `No unexpired licence or registration in ${missing.join(', ')}.` } : { complete: true, detail: `Licensed in ${licensed.join(', ')}.` };

  const seg = await segmentOn(tx, accountId, today);
  const pending = (await tx.query(`SELECT 1 FROM onboarding.segment_changes WHERE account_id = $1 AND status = 'pending'`, [accountId])).rowCount;
  items.segment = seg ? { complete: true, detail: `Segment ${seg}.` } : { complete: false, detail: pending ? 'A segment is waiting for an underwriter’s approval.' : 'Request a business segment; an underwriter approves it.' };

  const plans = p?.plans ?? [];
  if (!plans.length) items.plans = { complete: false, detail: 'Choose the plans the account sells.' };
  else {
    const rows = (await tx.query<{ code: string; state: string | null; published: boolean }>(
      `SELECT p.code, p.state, EXISTS (SELECT 1 FROM plans.plan_versions v WHERE v.plan_id = p.id AND v.status = 'published' AND v.effective_from <= $2::date AND (v.effective_to IS NULL OR v.effective_to > $2::date)) AS published
         FROM plans.plans p WHERE p.code = ANY ($1::text[])`,
      [plans, today],
    )).rows;
    const bad = plans.filter((c) => !rows.find((r) => r.code === c)?.published);
    const uncovered = states.filter((s) => !rows.some((r) => r.state === s && r.published));
    items.plans = bad.length ? { complete: false, detail: `Not published today: ${bad.join(', ')}.` } : uncovered.length ? { complete: false, detail: `No published plan for ${uncovered.join(', ')}.` } : { complete: true, detail: `${plans.join(', ')} published.` };
  }

  items.integration = p?.integration_method ? { complete: true, detail: p.integration_method } : { complete: false, detail: 'Choose how the account integrates.' };
  items.rate_basis = p?.rate_basis ? { complete: true, detail: 'Billing basis set.' } : { complete: false, detail: 'Set the account’s billing basis.' };
  items.settlement = p?.settlement ? { complete: true, detail: 'Settlement terms recorded.' } : { complete: false, detail: 'Record the settlement terms.' };
  const col = (await tx.query<{ not_collected: string[] }>(`SELECT not_collected FROM onboarding.collected_variables WHERE account_id = $1`, [accountId])).rows[0];
  items.collected_variables = col ? { complete: true, detail: col.not_collected.length ? `Does not collect ${col.not_collected.length} variable${col.not_collected.length === 1 ? '' : 's'}.` : 'Collects every rating variable.' } : { complete: false, detail: 'A rating analyst records which variables the account collects.' };

  if (acc.twin) {
    const t = (await tx.query<{ quotes: string; policies: string }>(`SELECT (SELECT count(*) FROM policies.quotes WHERE account_id = $1)::text AS quotes, (SELECT count(*) FROM policies.policies WHERE account_id = $1)::text AS policies`, [acc.twin])).rows[0]!;
    items.tested = Number(t.policies) > 0 ? { complete: true, detail: `The sandbox has made ${t.quotes} quote${t.quotes === '1' ? '' : 's'} and bound ${t.policies} polic${t.policies === '1' ? 'y' : 'ies'}.` } : { complete: false, detail: 'The sandbox has not yet bound a policy through the API.' };
  } else items.tested = { complete: false, detail: 'Create the sandbox, issue its credentials and bind a test policy.' };

  const list = ONBOARDING_ITEMS.map((item) => ({ item, label: ONBOARDING_LABELS[item], ...items[item] }));
  return { accountId, accountStatus: acc.status, sandbox: acc.sandbox, items: list, complete: list.every((i) => i.complete), sandboxAccountId: acc.twin, liveAt: acc.live_at ? acc.live_at.toISOString() : null };
}
