import { createHash } from 'node:crypto';
import {
  type CatalogueDocument,
  type EvaluationInput,
  type PlanDocument,
  type RuleSetDocument,
  type RuleTestCase,
} from '@astra/contracts';
import { AppError, canonicalJson, notFound, type Tx } from '@astra/platform';
import { Screener, type EvaluationData, type ExistingCover, type PlanFacts, type SanctionsEntry } from '@astra/underwriting';
import { versionInForce } from '@astra/studio';
import { variablesFor } from './plans';

/** Data the underwriting evaluation needs, read inside one transaction (ADR 0008). */

export interface RuleSetRow {
  id: string;
  plan_id: string;
  version: number;
  status: 'draft' | 'approved' | 'published' | 'superseded';
  effective_from: string;
  effective_to: string | null;
  document: RuleSetDocument;
  sha256: string | null;
  contributors: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  published_by: string | null;
  published_at: Date | null;
}

export interface PlanVersionRow {
  id: string;
  plan_id: string;
  version: number;
  status: string;
  catalogue_id: string;
  document: PlanDocument;
}

export interface PlanRow {
  id: string;
  code: string;
  kind: 'base' | 'state' | 'account';
  state: string | null;
  schedule_edition_id: string;
  policy_edition_id: string | null;
}

export const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

export async function planOf(tx: Tx, planId: string): Promise<PlanRow> {
  const p = (await tx.query<PlanRow>(`SELECT id, code, kind, state, schedule_edition_id, policy_edition_id FROM plans.plans WHERE id = $1`, [planId])).rows[0];
  if (!p) throw notFound('The plan');
  return p;
}

export async function planVersionOf(tx: Tx, id: string): Promise<PlanVersionRow> {
  const v = (await tx.query<PlanVersionRow>(`SELECT id, plan_id, version, status, catalogue_id, document FROM plans.plan_versions WHERE id = $1`, [id])).rows[0];
  if (!v) throw notFound('The plan version');
  return v;
}

export async function catalogueDocument(tx: Tx, id: string): Promise<CatalogueDocument> {
  const c = (await tx.query<{ document: CatalogueDocument }>(`SELECT document FROM studio.benefit_catalogues WHERE id = $1`, [id])).rows[0];
  if (!c) throw notFound('The benefit catalogue');
  return c.document;
}

/** The plan's time-sensitive period, CFAR cap and notice period, with units from the variable's filed range. */
export async function planFacts(tx: Tx, plan: PlanRow, doc: PlanDocument): Promise<PlanFacts> {
  const vars = await variablesFor(tx, plan.schedule_edition_id, plan.policy_edition_id);
  const setting = (name: string) => doc.settings.find((s) => s.setting === name);
  const num = (name: string): { value: number; unit: string | null } | null => {
    const s = setting(name);
    if (!s || typeof s.value !== 'number') return null;
    const unit = vars.get(`${s.variable.source}:${s.variable.key}`)?.constraints.unit;
    return { value: s.value, unit: typeof unit === 'string' ? unit : null };
  };
  const inDays = (n: { value: number; unit: string | null } | null) => (n ? (n.unit === 'hours' ? n.value / 24 : n.value) : null);
  const notice = num('cfar_notice_period');
  return {
    timeSensitiveDays: inDays(num('time_sensitive_period')),
    lookbackDays: inDays(num('lookback_period')),
    cfarTripCostCap: num('cfar_trip_cost_cap')?.value ?? null,
    cfarNoticePeriod: notice ? { value: notice.value, unit: notice.unit ?? 'days' } : null,
  };
}

/** One screener per approved list, kept in memory: the list is immutable once approved. */
const screeners = new Map<string, Screener>();

export async function approvedSanctions(tx: Tx): Promise<{ id: string; version: string; screener: Screener } | null> {
  const l = (await tx.query<{ id: string; source: string; published_on: string | null; sha256: string }>(
    `SELECT id, source, published_on::text, sha256 FROM underwriting.sanctions_lists WHERE status = 'approved'`,
  )).rows[0];
  if (!l) return null;
  let screener = screeners.get(l.id);
  if (!screener) {
    const { rows } = await tx.query<{ uid: string; name: string; program: string | null; aliases: string[]; births: SanctionsEntry['births'] }>(
      `SELECT uid, name, program, aliases, births FROM underwriting.sanctions_entries WHERE list_id = $1`,
      [l.id],
    );
    screener = new Screener(rows);
    screeners.clear();
    screeners.set(l.id, screener);
  }
  return { id: l.id, version: `${l.source}${l.published_on ? `, published ${l.published_on}` : ''}, ${l.sha256.slice(0, 8)}`, screener };
}

export async function prohibitedIn(tx: Tx, date: string): Promise<Map<string, string> | null> {
  const v = await versionInForce(tx, 'prohibited_destinations', date);
  if (!v) return null;
  const { rows } = await tx.query<{ key: string; data: { reason?: string } }>(`SELECT key, data FROM refdata.entries WHERE version_id = $1`, [v.id]);
  return new Map(rows.map((r) => [r.key, r.data.reason ?? 'On the prohibited destinations list']));
}

export async function coversFor(tx: Tx, input: EvaluationInput): Promise<{ covers: ExistingCover[]; rows: number }> {
  const births = input.travellers.map((t) => t.dateOfBirth).filter((d): d is string => !!d);
  const total = (await tx.query<{ n: string }>(`SELECT count(*) AS n FROM underwriting.cover_register WHERE status = 'active'`)).rows[0]!.n;
  if (!births.length) return { covers: [], rows: Number(total) };
  const { rows } = await tx.query<{ first_name: string; last_name: string; date_of_birth: string; policy_ref: string; trip_start: string; trip_end: string; term: 'single_trip' | 'annual' }>(
    `SELECT first_name, last_name, date_of_birth::text, policy_ref, trip_start::text, trip_end::text, term
       FROM underwriting.cover_register
      WHERE status = 'active' AND date_of_birth = ANY ($1::date[]) AND trip_start <= $3::date AND trip_end >= $2::date`,
    [births, input.trip.departureDate, input.trip.returnDate],
  );
  return {
    covers: rows.map((r) => ({ firstName: r.first_name, lastName: r.last_name, dateOfBirth: r.date_of_birth, policyRef: r.policy_ref, tripStart: r.trip_start, tripEnd: r.trip_end, term: r.term })),
    rows: Number(total),
  };
}

/** Everything the engine needs for one input. `testCovers` stand in for the register in test cases. */
export async function assemble(
  tx: Tx,
  planVersion: PlanVersionRow,
  ruleSet: RuleSetRow,
  input: EvaluationInput,
  preview: boolean,
  testCovers?: RuleTestCase['existingCovers'],
): Promise<EvaluationData> {
  const plan = await planOf(tx, planVersion.plan_id);
  if (plan.kind === 'base') throw new AppError('validation_failed', 'Base plans are templates and are not evaluated; use a state or account plan.');
  const [facts, prohibited, sanctions, register] = await Promise.all([
    planFacts(tx, plan, planVersion.document),
    prohibitedIn(tx, input.trip.departureDate),
    approvedSanctions(tx),
    testCovers ? Promise.resolve({ covers: testCovers as ExistingCover[], rows: testCovers.length }) : coversFor(tx, input),
  ]);
  return {
    planVersionId: planVersion.id,
    ruleSet: { id: ruleSet.id, version: ruleSet.version, document: ruleSet.document },
    plan: facts,
    preview,
    prohibited,
    sanctions: sanctions ? { version: sanctions.version, screener: sanctions.screener } : null,
    covers: register.covers,
    registerRows: register.rows,
  };
}
