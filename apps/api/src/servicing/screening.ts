import { createHash } from 'node:crypto';
import { ReferralRaised, RuleSetDocumentSchema, type EvaluationResult, type PolicySnapshot, type ServicingRequest } from '@astra/contracts';
import { publishEvent, writeAudit, type RequestContext, type Tx } from '@astra/platform';
import type { PossibleMatch } from '@astra/underwriting';
import { approvedSanctions } from '../routes/underwriting-data';

/**
 * Sanctions screening of the people a servicing action touches (E14-F03-S02): everyone who would be on the policy
 * after a change, and everyone a refund would reach. Quote and bind screen through the eligibility decision. A possible
 * match raises a hold for a person; a change waits for it, and a refund is recorded but not sent to billing until it is
 * cleared. Design: docs/adr/0020.
 */

export interface Party {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string | undefined;
}

const purchaserParty = (p: PolicySnapshot['purchaser']): Party[] => {
  const words = (p?.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return [{ id: 'PURCHASER', firstName: words.slice(0, -1).join(' '), lastName: words.at(-1)! }];
};

/** The travellers and purchaser as they would be after the request. */
export function partiesAfter(before: PolicySnapshot, req: ServicingRequest): Party[] {
  let travellers: Party[] = before.travellers.map((t) => ({ id: t.id, firstName: t.firstName, lastName: t.lastName, dateOfBirth: t.dateOfBirth ?? undefined }));
  let purchaser = before.purchaser;
  if (req.type === 'correct') {
    travellers = travellers.map((t) => {
      const c = req.travellers.find((x) => x.travellerId === t.id);
      return c ? { id: t.id, firstName: c.firstName ?? t.firstName, lastName: c.lastName ?? t.lastName, dateOfBirth: c.dateOfBirth ?? t.dateOfBirth } : t;
    });
    if (req.purchaser) purchaser = { name: req.purchaser.name ?? purchaser.name, email: req.purchaser.email ?? purchaser.email };
  }
  if (req.type === 'add_traveller') travellers.push({ id: 'NEW', firstName: req.traveller.firstName, lastName: req.traveller.lastName, dateOfBirth: req.traveller.dateOfBirth });
  if (req.type === 'remove_traveller') travellers = travellers.filter((t) => t.id !== req.travellerId);
  return [...travellers, ...purchaserParty(purchaser)];
}

export const currentParties = (record: PolicySnapshot): Party[] => partiesAfter(record, { type: 'cancel', reason: 'screening', noLoss: true });

export interface Screening {
  /** `clear`: nothing to hold; `held`: a person must look; `confirmed`: a person has said it is a match. */
  outcome: 'clear' | 'held' | 'confirmed';
  referralId: string | null;
  detail: string;
}

export async function screenParties(
  tx: Tx,
  ctx: RequestContext,
  args: { stage: 'change' | 'refund'; policyId: string; planVersionId: string; ruleSetId: string; parties: Party[]; raise: boolean },
): Promise<Screening> {
  const rs = (await tx.query<{ id: string; version: number; document: unknown }>(`SELECT id, version, document FROM underwriting.rule_sets WHERE id = $1`, [args.ruleSetId])).rows[0];
  const rules = RuleSetDocumentSchema.parse(rs?.document ?? {}).sanctions;
  if (!rules.enabled) return { outcome: 'clear', referralId: null, detail: 'This plan’s rules do not screen against a sanctions list.' };
  const list = await approvedSanctions(tx);
  const matches: PossibleMatch[] = list ? list.screener.screen(args.parties, rules.matchThreshold) : [];
  if (list && matches.length === 0) return { outcome: 'clear', referralId: null, detail: `Screened against the list ${list.version}; no possible match.` };

  // The case is named by who matched what, so a person's decision about it stands only for exactly that.
  const key = list ? matches.map((m) => `${args.parties.find((p) => p.id === m.travellerId)?.firstName} ${args.parties.find((p) => p.id === m.travellerId)?.lastName}|${m.uid}`.toLowerCase()).sort().join(';') : 'no-list';
  const caseRef = `${args.stage}:${args.policyId}:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  const detail = list ? `${matches.length} possible sanctions match(es) on the list ${list.version}.` : 'No approved sanctions list is loaded, so nobody could be screened.';
  const known = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM underwriting.referrals WHERE case_ref = $1 AND kind = 'sanctions' ORDER BY (status = 'open') DESC, created_at DESC LIMIT 1`, [caseRef])).rows[0];
  if (known?.status === 'approved') return { outcome: 'clear', referralId: known.id, detail: 'A person has cleared this match.' };
  if (known?.status === 'declined') return { outcome: 'confirmed', referralId: known.id, detail: 'A person has confirmed this sanctions match.' };
  if (known) return { outcome: 'held', referralId: known.id, detail };
  if (!args.raise) return { outcome: 'held', referralId: null, detail };

  const evaluation: EvaluationResult = {
    outcome: 'held',
    stage: args.stage,
    planVersionId: args.planVersionId,
    ruleSet: { id: args.ruleSetId, version: rs!.version },
    preview: false,
    checks: [{ area: 'sanctions', code: list ? 'sanctions_screening' : 'sanctions_list', passed: false, detail, travellerId: null }],
    reasons: [],
    referrals: [],
    waiver: { applies: false, conditions: [], timeSensitiveDays: null, lookbackDays: null },
    cfar: { passed: false, reference: 'Not decided by screening', reasons: [], offered: false, conditions: [], noticePeriod: null },
    benefitAvailability: [],
    screening: { listVersion: list?.version ?? null, screened: list ? args.parties.length : 0, possibleMatches: matches },
    duplicates: { registerRows: 0, matches: [] },
    referralId: null,
    summary: `${args.stage === 'refund' ? 'Refund held' : 'Change held'}. ${detail}`,
  };
  const id = (
    await tx.query<{ id: string }>(
      `INSERT INTO underwriting.referrals (case_ref, kind, stage, recommendation, rule_set_id, plan_version_id, summary, evaluation, created_by)
       VALUES ($1, 'sanctions', $2, 'refer', $3, $4, $5, $6, $7) RETURNING id`,
      [caseRef, args.stage, args.ruleSetId, args.planVersionId, evaluation.summary, JSON.stringify(evaluation), ctx.principal.subject],
    )
  ).rows[0]!.id;
  await publishEvent(tx, ctx, ReferralRaised, { referralId: id, caseRef, kind: 'sanctions', stage: args.stage, recommendation: 'refer' }, { accountId: null });
  await writeAudit(tx, ctx, { action: 'referral.raised', resourceType: 'referral', resourceId: id, data: { caseRef, kind: 'sanctions', stage: args.stage, possibleMatches: matches.length } });
  return { outcome: 'held', referralId: id, detail };
}

/** Why a refund on this policy may not be paid yet; null when nothing holds it. */
export async function refundHold(tx: Tx, policyId: string): Promise<string | null> {
  const r = (
    await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM underwriting.referrals WHERE kind = 'sanctions' AND case_ref LIKE 'refund:' || $1 || ':%' AND status <> 'approved' ORDER BY (status = 'declined') DESC, created_at DESC LIMIT 1`,
      [policyId],
    )
  ).rows[0];
  if (!r) return null;
  return r.status === 'declined' ? `Do not pay: a sanctions match was confirmed on this refund (referral ${r.id}).` : `Refund held for sanctions review (referral ${r.id}).`;
}
