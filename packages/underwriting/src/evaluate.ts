import Decimal from 'decimal.js';
import {
  LIMIT_LABELS,
  type Check,
  type EvaluationInput,
  type EvaluationResult,
  type RuleSetDocument,
} from '@astra/contracts';
import { findDuplicates, type ExistingCover } from './duplicates';
import { describeCondition, evaluateCondition, type FieldContext } from './rules';
import type { Screener } from './sanctions';

/** Eligibility evaluation at quote, bind and change (E03). Pure: the caller supplies the data. Design: docs/adr/0008. */

/** The filed condition that the relevant trip costs are insured in full (specification, M3.2 and M3.3). */
export const FILED_INSURED_PERCENT = 100;

export interface PlanFacts {
  /** Days after the initial deposit within which the policy must be bought (plan setting). */
  timeSensitiveDays: number | null;
  lookbackDays: number | null;
  cfarTripCostCap: number | null;
  /** Stored for later checks at cancellation (E03-F03-S01). */
  cfarNoticePeriod: { value: number; unit: string } | null;
}

export interface EvaluationData {
  planVersionId: string;
  ruleSet: { id: string; version: number; document: RuleSetDocument };
  plan: PlanFacts;
  preview: boolean;
  /** Prohibited destinations in force on the departure date: country to reason; null when no version is in force. */
  prohibited: Map<string, string> | null;
  /** Approved sanctions list; null when none is loaded. */
  sanctions: { version: string; screener: Screener } | null;
  covers: ExistingCover[];
  registerRows: number;
}

const DAY = 86_400_000;
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

function ageOn(dob: string, on: string): number {
  let age = Number(on.slice(0, 4)) - Number(dob.slice(0, 4));
  if (on.slice(5) < dob.slice(5)) age--;
  return age;
}

const usd = (n: Decimal.Value) =>
  `$${new Decimal(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

export function evaluate(input: EvaluationInput, data: EvaluationData): EvaluationResult {
  const doc = data.ruleSet.document;
  const t = input.trip;
  const checks: Check[] = [];
  const reasons: string[] = [];
  const add = (c: Omit<Check, 'travellerId'> & { travellerId?: string | null }): Check => {
    const full: Check = { ...c, travellerId: c.travellerId ?? null };
    checks.push(full);
    return full;
  };
  const asOf = input.asOf ?? t.purchaseDate;
  const tripDays = days(t.departureDate, t.returnDate) + 1;
  const daysBefore = days(asOf, t.departureDate);
  const count = input.travellers.length;
  const total =
    t.totalTripCost !== undefined
      ? new Decimal(t.totalTripCost)
      : input.travellers.every((x) => x.costPerTraveller !== undefined)
        ? input.travellers.reduce((s, x) => s.plus(x.costPerTraveller!), new Decimal(0))
        : null;
  const perTraveller = (x: EvaluationInput['travellers'][number]): Decimal | null =>
    x.costPerTraveller !== undefined
      ? new Decimal(x.costPerTraveller)
      : total
        ? total.div(count)
        : null;
  const ageOf = (x: EvaluationInput['travellers'][number]) =>
    x.age ?? ageOn(x.dateOfBirth!, t.purchaseDate);

  // ---- Able-to-travel declaration (E03-F01-S01)
  if (doc.ableToTravelRequired) {
    const ok = input.ableToTravel === true;
    add({
      area: 'declaration',
      code: 'able_to_travel',
      passed: ok,
      detail: ok
        ? 'The traveller confirmed they are able to travel.'
        : input.ableToTravel === false
          ? 'The traveller said they are not able to travel.'
          : 'The traveller has not confirmed they are able to travel.',
    });
    if (!ok && (input.ableToTravel === false || input.stage === 'bind')) {
      reasons.push(
        input.ableToTravel === false
          ? 'The traveller is not able to travel, so cover cannot be issued.'
          : 'The able-to-travel confirmation is needed to issue cover.',
      );
    }
  }

  // ---- Plan limits (E03-F01-S02)
  for (const l of doc.limits) {
    for (const x of input.travellers) {
      let value: number | null;
      switch (l.kind) {
        case 'min_age':
        case 'max_age':
          value = ageOf(x);
          break;
        case 'min_trip_days':
        case 'max_trip_days':
          value = tripDays;
          break;
        default:
          value = perTraveller(x)?.toNumber() ?? null;
      }
      if (value === null) {
        add({
          area: 'limit',
          code: l.code,
          passed: false,
          detail: `${LIMIT_LABELS[l.kind]} cannot be checked: the trip cost is not given.`,
          travellerId: x.id,
        });
        reasons.push(`${LIMIT_LABELS[l.kind]} cannot be checked because the trip cost is missing.`);
        continue;
      }
      const isMin = l.kind.startsWith('min_');
      const passed = isMin ? value >= l.value : value <= l.value;
      const money = l.kind.endsWith('trip_cost');
      const show = (n: number) => (money ? usd(n) : String(n));
      const detail = `${LIMIT_LABELS[l.kind]}: ${show(l.value)}; this trip is ${show(value)}.`;
      add({ area: 'limit', code: l.code, passed, detail, travellerId: count > 1 ? x.id : null });
      if (!passed) {
        const who = count > 1 ? `Traveller ${x.id}: ` : '';
        const unit = l.kind.endsWith('age') ? ' years' : l.kind.endsWith('days') ? ' days' : '';
        reasons.push(
          `${who}${LIMIT_LABELS[l.kind].replace(/ \(days\)$/, '').replace(/ per traveller$/, '')} for this plan is ${show(l.value)}${unit}; this ${l.kind.endsWith('age') ? 'traveller is ' + value : l.kind.endsWith('days') ? 'trip is ' + value + ' days' : 'trip costs ' + show(value)}.`,
        );
      }
    }
  }

  // ---- Prohibited destinations (E03-F04-S01)
  if (doc.prohibitedDestinations) {
    if (!data.prohibited) {
      add({
        area: 'prohibited_destination',
        code: 'prohibited_destinations',
        passed: false,
        detail:
          'No prohibited destinations list is in force on the departure date, so destinations could not be checked.',
      });
    } else {
      const hits = t.destinations.filter((d) => d.country && data.prohibited!.has(d.country));
      add({
        area: 'prohibited_destination',
        code: 'prohibited_destinations',
        passed: hits.length === 0,
        detail: hits.length
          ? `Prohibited: ${hits.map((h) => h.country).join(', ')}.`
          : 'No destination is on the prohibited list.',
      });
      for (const h of hits)
        reasons.push(
          `Cover is not offered for travel to ${h.country}: ${data.prohibited.get(h.country!)}.`,
        );
    }
  }

  // ---- Duplicate cover (E03-F04-S02)
  const dupMatches: EvaluationResult['duplicates']['matches'] = [];
  if (doc.duplicates.enabled && input.stage !== 'quote') {
    for (const x of input.travellers) {
      if (!x.dateOfBirth) {
        add({
          area: 'duplicate',
          code: 'duplicate_cover',
          passed: false,
          detail: 'Duplicate cover cannot be checked without a date of birth.',
          travellerId: x.id,
        });
        continue;
      }
      const found = findDuplicates(
        x,
        { start: t.departureDate, end: t.returnDate, term: input.term, policyRef: input.policyRef },
        data.covers,
        doc.duplicates.allowSingleAndAnnual,
      );
      for (const f of found)
        dupMatches.push({
          travellerId: x.id,
          policyRef: f.policyRef,
          tripStart: f.tripStart,
          tripEnd: f.tripEnd,
          term: f.term,
        });
      add({
        area: 'duplicate',
        code: 'duplicate_cover',
        passed: found.length === 0,
        detail: found.length
          ? `Already covered by ${found.map((f) => f.policyRef).join(', ')} for dates that overlap.`
          : 'No other cover for these dates.',
        travellerId: count > 1 ? x.id : null,
      });
      for (const f of found)
        reasons.push(
          `${count > 1 ? `Traveller ${x.id} is` : 'The traveller is'} already covered by policy ${f.policyRef} (${f.tripStart} to ${f.tripEnd}), so a second policy for these dates is not allowed.`,
        );
    }
  }

  // ---- Time-sensitive period, waiver and CFAR (E03-F02, E03-F03)
  const period = data.plan.timeSensitiveDays;
  const received = t.premiumReceivedDate ?? t.purchaseDate;
  const withinPeriod = (date: string, what: string): Check => {
    if (period === null)
      return {
        area: 'waiver',
        code: 'time_sensitive_period',
        passed: false,
        detail: 'The plan has no time-sensitive period set.',
        travellerId: null,
      };
    if (!t.initialDepositDate)
      return {
        area: 'waiver',
        code: 'time_sensitive_period',
        passed: false,
        detail: `The initial trip deposit date is not given, so ${what} cannot be shown to be within the ${period}-day time-sensitive period.`,
        travellerId: null,
      };
    const gap = days(t.initialDepositDate, date);
    return {
      area: 'waiver',
      code: 'time_sensitive_period',
      passed: gap >= 0 && gap <= period,
      detail: `${what} ${gap} day${gap === 1 ? '' : 's'} after the initial deposit on ${t.initialDepositDate}; the period is ${period} days.`,
      travellerId: null,
    };
  };
  const insured: Check = {
    area: 'waiver',
    code: 'fully_insured',
    passed: input.insuredPercent >= FILED_INSURED_PERCENT,
    detail: `${input.insuredPercent}% of the relevant trip costs are insured; ${FILED_INSURED_PERCENT}% is needed.`,
    travellerId: null,
  };
  const able: Check = {
    area: 'waiver',
    code: 'able_to_travel',
    passed: input.ableToTravel === true,
    detail:
      input.ableToTravel === true
        ? 'The traveller confirmed they are able to travel.'
        : 'The traveller has not confirmed they are able to travel.',
    travellerId: null,
  };

  const waiverConditions: Check[] = [
    { ...withinPeriod(received, 'The premium is received'), code: 'premium_in_period' },
    insured,
    able,
  ];
  const waiverApplies = waiverConditions.every((c) => c.passed);
  checks.push(...waiverConditions.map((c) => ({ ...c, area: 'waiver' as const })));

  const capCheck: Check =
    data.plan.cfarTripCostCap === null
      ? {
          area: 'cfar',
          code: 'trip_cost_cap',
          passed: false,
          detail: 'The plan has no CFAR trip cost cap set.',
          travellerId: null,
        }
      : total === null
        ? {
            area: 'cfar',
            code: 'trip_cost_cap',
            passed: false,
            detail: 'The trip cost is not given, so the CFAR cap cannot be checked.',
            travellerId: null,
          }
        : {
            area: 'cfar',
            code: 'trip_cost_cap',
            passed: total.lte(data.plan.cfarTripCostCap),
            detail: `The trip costs ${usd(total)}; the CFAR cap is ${usd(data.plan.cfarTripCostCap)}.`,
            travellerId: null,
          };
  const cfarConditions: Check[] = [
    {
      ...withinPeriod(t.purchaseDate, 'The policy is bought'),
      area: 'cfar',
      code: 'purchased_in_period',
    },
    { ...able, area: 'cfar' },
    { ...insured, area: 'cfar' },
    capCheck,
  ];
  const cfarPassed = cfarConditions.every((c) => c.passed);
  checks.push(...cfarConditions);
  const cfarReasons = cfarConditions.filter((c) => !c.passed).map((c) => c.detail);

  const timeCheck = withinPeriod(t.purchaseDate, 'The policy is bought');
  const timeBased = [
    ...new Set([...doc.timeBasedBenefits.map((b) => b.benefit), ...input.benefits]),
  ];
  const benefitAvailability = timeBased.map((b) => {
    const conditional = doc.timeBasedBenefits.some((x) => x.benefit === b);
    if (!conditional) return { benefit: b, available: true, reason: 'No time condition.' };
    checks.push({
      area: 'time_based',
      code: b,
      passed: timeCheck.passed,
      detail: timeCheck.detail,
      travellerId: null,
    });
    return {
      benefit: b,
      available: timeCheck.passed,
      reason: timeCheck.passed
        ? 'Bought within the time-sensitive period.'
        : `Not available: ${timeCheck.detail}`,
    };
  });

  // ---- Referral rules (E03-F05-S01)
  const referrals: EvaluationResult['referrals'] = [];
  for (const r of doc.referralRules) {
    const fired = input.travellers.some((x) => {
      const ctx: FieldContext = {
        traveller_age: ageOf(x),
        cost_per_traveller: perTraveller(x)?.toNumber() ?? null,
        trip_days: tripDays,
        total_trip_cost: total?.toNumber() ?? null,
        traveller_count: count,
        destination_country: t.destinations.map((d) => d.country ?? null),
        destination_region: t.destinations.map((d) => d.region ?? null),
        business_segment: input.businessSegment ?? null,
        days_before_departure: daysBefore,
        insured_percent: input.insuredPercent,
      };
      return evaluateCondition(r.when, ctx);
    });
    add({
      area: 'referral_rule',
      code: r.code,
      passed: !fired,
      detail: fired ? `${r.name}: ${describeCondition(r.when)}.` : `${r.name}: not triggered.`,
    });
    if (fired) referrals.push({ rule: r.code, reason: r.reason, recommendation: r.action });
  }

  // ---- Sanctions screening (E03-F04-S01)
  let possible: EvaluationResult['screening']['possibleMatches'] = [];
  let screened = 0;
  let sanctionsHold = false;
  if (doc.sanctions.enabled) {
    if (!data.sanctions) {
      add({
        area: 'sanctions',
        code: 'sanctions_list',
        passed: false,
        detail: 'No approved sanctions list is loaded, so travellers could not be screened.',
      });
      // Without a list nobody can be cleared at bind.
      sanctionsHold = input.stage === 'bind';
    } else {
      possible = data.sanctions.screener.screen(input.travellers, doc.sanctions.matchThreshold);
      screened = input.travellers.length;
      add({
        area: 'sanctions',
        code: 'sanctions_screening',
        passed: possible.length === 0,
        detail: possible.length
          ? `${possible.length} possible match${possible.length === 1 ? '' : 'es'} on the OFAC list (${data.sanctions.version}).`
          : `${screened} traveller${screened === 1 ? '' : 's'} screened against the OFAC list (${data.sanctions.version}); no possible match.`,
      });
      sanctionsHold = possible.length > 0;
    }
  }

  const outcome: EvaluationResult['outcome'] = sanctionsHold
    ? 'held'
    : reasons.length
      ? 'ineligible'
      : referrals.length
        ? 'referred'
        : 'eligible';

  const result: EvaluationResult = {
    outcome,
    stage: input.stage,
    planVersionId: data.planVersionId,
    ruleSet: { id: data.ruleSet.id, version: data.ruleSet.version },
    preview: data.preview,
    checks,
    reasons,
    referrals,
    waiver: {
      applies: waiverApplies,
      conditions: waiverConditions,
      timeSensitiveDays: period,
      lookbackDays: data.plan.lookbackDays,
    },
    cfar: {
      passed: cfarPassed,
      offered: cfarPassed,
      reference: `rule set ${data.ruleSet.id} v${data.ruleSet.version}`,
      reasons: cfarReasons,
      conditions: cfarConditions,
      noticePeriod: data.plan.cfarNoticePeriod?.value ?? null,
    },
    benefitAvailability,
    screening: {
      listVersion: data.sanctions?.version ?? null,
      screened,
      possibleMatches: possible,
    },
    duplicates: { registerRows: data.registerRows, matches: dupMatches },
    referralId: null,
    summary: '',
  };
  result.summary = summarise(input, result);
  return result;
}

/** A case summary for the underwriter, built from the rule results (the AG-04 agent summary replaces it later). */
export function summarise(input: EvaluationInput, r: EvaluationResult): string {
  const lines: string[] = [];
  const who = input.travellers.map((t) => `${t.firstName} ${t.lastName}`).join(', ');
  lines.push(
    `${input.stage[0]!.toUpperCase()}${input.stage.slice(1)} for ${who}; trip ${input.trip.departureDate} to ${input.trip.returnDate}.`,
  );
  lines.push(`Outcome: ${r.outcome}.`);
  for (const p of r.screening.possibleMatches)
    lines.push(
      `Possible sanctions match: traveller ${p.travellerId} against ${p.name}${p.program ? ` (${p.program})` : ''}, score ${p.score}. ${p.reason}.`,
    );
  if (r.outcome === 'held' && r.screening.listVersion === null)
    lines.push('No approved sanctions list was available to screen against.');
  for (const x of r.referrals)
    lines.push(
      `Rule ${x.rule} (${x.recommendation === 'recommend_decline' ? 'recommends decline' : 'refer'}): ${x.reason}`,
    );
  for (const x of r.reasons) lines.push(`Not eligible: ${x}`);
  lines.push(
    `Pre-existing waiver: ${r.waiver.applies ? 'applies' : 'does not apply'}. CFAR: ${r.cfar.offered ? 'offered' : 'not offered'}.`,
  );
  return lines.join('\n');
}
