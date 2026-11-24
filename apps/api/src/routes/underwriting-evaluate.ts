import { ReferralRaised, type EvaluationInput, type EvaluationResult } from '@astra/contracts';
import { AppError, notFound, preconditionFailed, publishEvent, writeAudit, type RequestContext, type Tx } from '@astra/platform';
import { evaluate } from '@astra/underwriting';
import { assemble, planVersionOf, type RuleSetRow } from './underwriting-data';

/**
 * Decides eligibility with the plan's rule set and, when asked, keeps a referral for a referred or held case
 * (E03). Used by the evaluate API and by quote and bind. Design: docs/adr/0008.
 */
export async function runEvaluation(
  tx: Tx,
  ctx: RequestContext,
  args: { planVersionId: string; ruleSetId?: string | undefined; input: EvaluationInput; persist: boolean; caseRef?: string | undefined },
): Promise<EvaluationResult> {
  const { planVersionId, ruleSetId, input, persist, caseRef } = args;
  if (persist && !caseRef) throw new AppError('validation_failed', 'Give a caseRef to keep a referral.', [{ code: 'case_ref', field: 'caseRef', message: 'Needed with persist' }]);
  const pv = await planVersionOf(tx, planVersionId);
  const asOf = input.asOf ?? input.trip.purchaseDate;
  let rs: RuleSetRow | undefined;
  if (ruleSetId) {
    rs = (await tx.query<RuleSetRow>(`SELECT * FROM underwriting.rule_sets WHERE id = $1`, [ruleSetId])).rows[0];
    if (!rs) throw notFound('The rule set');
    if (rs.plan_id !== pv.plan_id) throw new AppError('validation_failed', 'That rule set belongs to another plan.');
  } else {
    rs = (
      await tx.query<RuleSetRow>(
        `SELECT * FROM underwriting.rule_sets WHERE plan_id = $1 AND status = 'published' AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to > $2::date)`,
        [pv.plan_id, asOf],
      )
    ).rows[0];
    if (!rs) throw preconditionFailed(`No published rule set is in effect for this plan on ${asOf}, so eligibility cannot be decided.`);
  }
  const preview = rs.status !== 'published' || pv.status !== 'published';
  const data = await assemble(tx, pv, rs, input, preview);
  const result = evaluate(input, data);
  if (persist && (result.outcome === 'referred' || result.outcome === 'held')) {
    const kind = result.outcome === 'held' ? ('sanctions' as const) : ('underwriting' as const);
    const existing = (await tx.query<{ id: string }>(`SELECT id FROM underwriting.referrals WHERE case_ref = $1 AND kind = $2 AND status = 'open'`, [caseRef, kind])).rows[0];
    if (existing) result.referralId = existing.id;
    else {
      const recommendation = result.referrals.some((x) => x.recommendation === 'recommend_decline') ? ('recommend_decline' as const) : ('refer' as const);
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO underwriting.referrals (case_ref, kind, stage, recommendation, rule_set_id, plan_version_id, summary, evaluation, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [caseRef, kind, input.stage, recommendation, rs.id, pv.id, result.summary, JSON.stringify({ ...result, referralId: null }), ctx.principal.subject],
        )
      ).rows[0]!.id;
      result.referralId = id;
      await publishEvent(tx, ctx, ReferralRaised, { referralId: id, caseRef: caseRef!, kind, stage: input.stage, recommendation }, { accountId: null });
      await writeAudit(tx, ctx, { action: 'referral.raised', resourceType: 'referral', resourceId: id, data: { caseRef, kind, stage: input.stage, rules: result.referrals.map((x) => x.rule), possibleMatches: result.screening.possibleMatches.length } });
    }
  }
  return result;
}
