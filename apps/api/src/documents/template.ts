import { REFDATA_DATASETS, type PlanDocument, type Template, type TemplateCheck, type TemplateKind, type VariableType } from '@astra/contracts';
import { assemble, type AssemblyVariable, type ResolvedValue } from '@astra/documents';
import { AppError, conflict, notFound, type Tx } from '@astra/platform';
import { checkValue, versionInForce } from '@astra/studio';

/** Assembling a plan version's schedule or policy from its filed form and the plan's values. Design: docs/adr/0011. */

export interface Built {
  planVersion: { id: string; version: number; status: string; planCode: string; planName: string };
  edition: { id: string; formNumber: string; edition: string };
  map: { id: string; version: number };
  text: string;
  problems: { variable: string | null; message: string }[];
  inserted: number;
  removed: string[];
  /** The checks of the assembly itself; the quality check is added when the template is viewed. */
  checks: TemplateCheck[];
}

const refKey = (r: { source: string; key: string }) => `${r.source}:${r.key}`;
const today = () => new Date().toISOString().slice(0, 10);

const regionName = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const nameOf = (key: string) => (/^[A-Z]{2}$/.test(key) ? (regionName?.of(key) ?? key) : key);

export async function assembleFor(tx: Tx, planVersionId: string, kind: TemplateKind): Promise<Built> {
  const pv = (
    await tx.query<{ id: string; version: number; status: string; document: PlanDocument; code: string; name: string; schedule_edition_id: string; policy_edition_id: string | null }>(
      `SELECT v.id, v.version, v.status, v.document, p.code, p.name, p.schedule_edition_id, p.policy_edition_id
         FROM plans.plan_versions v JOIN plans.plans p ON p.id = v.plan_id WHERE v.id = $1`,
      [planVersionId],
    )
  ).rows[0];
  if (!pv) throw notFound('The plan version');
  if (!['approved', 'published'].includes(pv.status)) throw conflict(`The plan version is ${pv.status}; templates are made from approved or published versions.`);
  const editionId = kind === 'schedule' ? pv.schedule_edition_id : pv.policy_edition_id;
  if (!editionId) throw new AppError('validation_failed', `The plan has no ${kind} form.`);
  const ed = (await tx.query<{ id: string; form_number: string; edition: string; text: string }>(`SELECT id, form_number, edition, text FROM studio.form_editions WHERE id = $1`, [editionId])).rows[0]!;
  const map = (await tx.query<{ id: string; version: number }>(`SELECT id, version FROM studio.variable_maps WHERE edition_id = $1 AND status = 'approved'`, [editionId])).rows[0];
  if (!map) throw conflict(`The ${ed.form_number} edition ${ed.edition} has no approved variable map. Approve one first.`);
  const vars = (
    await tx.query<{ key: string; label: string; type: VariableType; constraints: Record<string, unknown>; text_start: number; text_end: number; excerpt: string }>(
      `SELECT key, label, type, constraints, text_start, text_end, excerpt FROM studio.form_variables WHERE map_id = $1 ORDER BY position`,
      [map.id],
    )
  ).rows;

  // The plan's values, then its settings (which carry the values of the variables they are filed as).
  const values = new Map<string, ResolvedValue>();
  for (const [k, v] of Object.entries(pv.document.values)) values.set(k, v);
  for (const s of pv.document.settings) if (!values.has(refKey(s.variable))) values.set(refKey(s.variable), s.value);

  const notes: string[] = [];
  const variables: AssemblyVariable[] = [];
  for (const v of vars) {
    const ref = `${kind}:${v.key}`;
    variables.push({ ref, label: v.label, type: v.type, constraints: v.constraints, start: v.text_start, end: v.text_end, excerpt: v.excerpt });
    if (v.type === 'insert_placeholder' && v.constraints.source === 'dataset') {
      const dataset = String(v.constraints.dataset);
      if (!(dataset in REFDATA_DATASETS)) continue;
      const ver = await versionInForce(tx, dataset, today());
      if (!ver) {
        values.delete(ref);
        continue;
      }
      const { rows } = await tx.query<{ key: string }>(`SELECT key FROM refdata.entries WHERE version_id = $1 ORDER BY key`, [ver.id]);
      values.set(ref, rows.map((r) => nameOf(r.key)).join(', '));
      notes.push(`${v.label}: ${dataset.replace(/_/g, ' ')}, version in force on ${today()}`);
    }
  }

  const result = assemble(ed.text, variables, values);

  const accountedInside = (v: AssemblyVariable) => variables.some((o) => result.removed.includes(o.ref) && o.start <= v.start && o.end >= v.end && o.ref !== v.ref);
  const unaccounted = variables.filter((v) => !result.inserted.includes(v.ref) && !result.removed.includes(v.ref) && !accountedInside(v));
  const outOfRange: string[] = [];
  for (const v of vars) {
    const ref = `${kind}:${v.key}`;
    if (!result.inserted.includes(ref) || v.type === 'insert_placeholder' || v.type === 'optional_benefit') continue;
    const r = checkValue({ label: v.label, type: v.type, constraints: v.constraints }, values.get(ref));
    if (!r.ok) outOfRange.push(r.message);
  }
  const checks: TemplateCheck[] = [
    { check: 'assembled', passed: result.problems.length === 0, detail: result.problems.length ? `${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}: ${result.problems[0]!.message}` : `Assembled with no bracket, option or placeholder left${notes.length ? `. ${notes.join('; ')}` : ''}.` },
    { check: 'accounted', passed: unaccounted.length === 0, detail: unaccounted.length ? `No value or decision for: ${unaccounted.map((v) => v.label).join('; ')}.` : `All ${variables.length} variables of the approved map (version ${map.version}) are accounted for: ${result.inserted.length} filled, ${result.removed.length} optional benefit${result.removed.length === 1 ? '' : 's'} left out.` },
    { check: 'in_range', passed: outOfRange.length === 0, detail: outOfRange.length ? outOfRange.join(' ') : 'Every value is within its filed range or options.' },
  ];
  return {
    planVersion: { id: pv.id, version: pv.version, status: pv.status, planCode: pv.code, planName: pv.name },
    edition: { id: ed.id, formNumber: ed.form_number, edition: ed.edition },
    map,
    text: result.text,
    problems: result.problems,
    inserted: result.inserted.length,
    removed: result.removed,
    checks,
  };
}

export interface TemplateRow {
  id: string;
  plan_version_id: string;
  kind: TemplateKind;
  version: number;
  status: 'draft' | 'released' | 'superseded';
  edition_id: string;
  map_id: string;
  text: string;
  problems: { variable: string | null; message: string }[];
  inserted: number;
  removed: string[];
  checks: TemplateCheck[];
  created_by: string;
  created_at: Date;
  released_by: string | null;
  released_at: Date | null;
}

/** Findings of the Document Quality agent that hold a release: open ones, and accepted ones (the template has a defect). */
export async function holdsFor(tx: Tx, subjectId: string): Promise<{ open: number; accepted: number }> {
  const { rows } = await tx.query<{ status: string; content: { findings?: { severity?: string }[] }; resolution: { accepted?: string[] } | null }>(
    `SELECT status, content, resolution FROM agents.proposals WHERE kind = 'document_quality' AND subject_id = $1 AND status IN ('open', 'resolved')`,
    [subjectId],
  );
  let open = 0;
  let accepted = 0;
  for (const r of rows) {
    const holds = (r.content.findings ?? []).map((f, i) => ({ id: `f${i + 1}`, hold: (f.severity ?? 'hold') === 'hold' })).filter((f) => f.hold);
    if (r.status === 'open') open += holds.length;
    else accepted += holds.filter((f) => (r.resolution?.accepted ?? []).includes(f.id)).length;
  }
  return { open, accepted };
}

export async function templateView(tx: Tx, row: TemplateRow): Promise<Template> {
  const info = (
    await tx.query<{ version: number; code: string; name: string; form_number: string; edition: string; map_version: number }>(
      `SELECT v.version, p.code, p.name, e.form_number, e.edition, m.version AS map_version
         FROM plans.plan_versions v JOIN plans.plans p ON p.id = v.plan_id, studio.form_editions e, studio.variable_maps m
        WHERE v.id = $1 AND e.id = $2 AND m.id = $3`,
      [row.plan_version_id, row.edition_id, row.map_id],
    )
  ).rows[0]!;
  const holds = await holdsFor(tx, row.id);
  const held = holds.open + holds.accepted;
  const checks: TemplateCheck[] = [
    ...row.checks,
    { check: 'quality', passed: held === 0, detail: held === 0 ? 'No finding of the Document Quality agent holds this template.' : `${holds.open} open and ${holds.accepted} accepted finding${held === 1 ? '' : 's'} of the Document Quality agent hold this template.` },
  ];
  return {
    id: row.id,
    planVersionId: row.plan_version_id,
    planCode: info.code,
    planName: info.name,
    planVersion: info.version,
    kind: row.kind,
    version: row.version,
    status: row.status,
    form: { editionId: row.edition_id, formNumber: info.form_number, edition: info.edition, mapId: row.map_id, mapVersion: info.map_version },
    text: row.text,
    problems: row.problems,
    inserted: row.inserted,
    removed: row.removed,
    checks,
    holds,
    releasable: row.status === 'draft' && checks.every((c) => c.passed),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    releasedBy: row.released_by,
    releasedAt: row.released_at ? row.released_at.toISOString() : null,
  };
}
