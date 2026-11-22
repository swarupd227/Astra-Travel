import {
  COUNTRY_REFERENCES,
  REFDATA_DATASETS,
  STATE_REFERENCES,
  type RefdataDataset,
  type RefdataVersion,
} from '@astra/contracts';
import { AppError, conflict, writeAudit, type RequestContext, type Tx } from '@astra/platform';
import { validateEntries } from './refdata';

/** Reference data versions in the database: loading (as a draft) and lookups as of a date. */

export interface VersionRow {
  id: string;
  dataset: string;
  version: number;
  status: RefdataVersion['status'];
  effective_from: string;
  effective_to: string | null;
  source: string;
  notes: string | null;
  entry_count: number;
  sha256: string;
  loaded_by: string;
  loaded_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

export const toVersion = (r: VersionRow): RefdataVersion => ({
  id: r.id,
  dataset: r.dataset,
  version: r.version,
  status: r.status,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  source: r.source,
  notes: r.notes,
  entryCount: r.entry_count,
  sha256: r.sha256,
  loadedBy: r.loaded_by,
  loadedAt: r.loaded_at.toISOString(),
  decidedBy: r.decided_by,
  decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  decisionReason: r.decision_reason,
});

/** The approved version of a dataset in force on a date. */
export async function versionInForce(
  tx: Tx,
  dataset: string,
  date: string,
): Promise<VersionRow | null> {
  const { rows } = await tx.query<VersionRow>(
    `SELECT * FROM refdata.versions
      WHERE dataset = $1 AND status = 'approved' AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to > $2::date)`,
    [dataset, date],
  );
  return rows[0] ?? null;
}

/** Keys of the dataset in force on a date, or null when no version is in force. */
export async function keysInForce(
  tx: Tx,
  dataset: string,
  date: string,
): Promise<Set<string> | null> {
  const v = await versionInForce(tx, dataset, date);
  if (!v) return null;
  const { rows } = await tx.query<{ key: string }>(
    `SELECT key FROM refdata.entries WHERE version_id = $1`,
    [v.id],
  );
  return new Set(rows.map((r) => r.key));
}

export async function latestApproved(tx: Tx, dataset: string): Promise<VersionRow | null> {
  const { rows } = await tx.query<VersionRow>(
    `SELECT * FROM refdata.versions WHERE dataset = $1 AND status = 'approved' ORDER BY effective_from DESC LIMIT 1`,
    [dataset],
  );
  return rows[0] ?? null;
}

export interface LoadRequest {
  effectiveFrom: string;
  source: string;
  notes?: string | undefined;
  entries: Record<string, unknown>[];
}

/**
 * Validates and stores a complete snapshot as a draft version. Nothing is stored if any entry is wrong.
 * It takes effect only when someone other than the loader approves it.
 */
export async function loadVersion(
  tx: Tx,
  ctx: RequestContext,
  dataset: RefdataDataset,
  req: LoadRequest,
): Promise<VersionRow> {
  const checked = validateEntries(dataset, req.entries);
  const problems = [...checked.problems];
  // Codes that refer to other datasets must exist in the version in force on the effective date.
  for (const [refs, target, label] of [
    [COUNTRY_REFERENCES[dataset], 'countries', 'country'],
    [STATE_REFERENCES[dataset], 'us_states', 'state'],
  ] as const) {
    if (!refs) continue;
    const known = await keysInForce(tx, target, req.effectiveFrom);
    if (!known) {
      throw new AppError(
        'precondition_failed',
        `Approve the ${REFDATA_DATASETS[target].name.toLowerCase()} reference data first: this dataset refers to it.`,
      );
    }
    for (const e of checked.entries) {
      for (const code of refs(e.data)) {
        if (!known.has(code))
          problems.push({ row: 0, field: e.key, message: `Unknown ${label} code ${code}.` });
      }
    }
  }
  if (problems.length) {
    throw new AppError(
      'validation_failed',
      `${problems.length} problem${problems.length === 1 ? '' : 's'} in the entries; nothing was loaded.`,
      problems.slice(0, 100).map((p) => ({
        code: 'invalid_entry',
        field: p.row ? `entries[${p.row - 1}].${p.field}` : `entries.${p.field}`,
        message: p.row ? `Row ${p.row}: ${p.message}` : `${p.field}: ${p.message}`,
      })),
    );
  }
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('refdata:' || $1))`, [dataset]);
  const latest = await latestApproved(tx, dataset);
  if (latest && req.effectiveFrom <= latest.effective_from) {
    throw conflict(
      `Version ${latest.version} is in force from ${latest.effective_from}; a new version must start after that date.`,
    );
  }
  const next = await tx.query<{ n: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS n FROM refdata.versions WHERE dataset = $1`,
    [dataset],
  );
  const row = (
    await tx.query<VersionRow>(
      `INSERT INTO refdata.versions (dataset, version, effective_from, source, notes, entry_count, sha256, loaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        dataset,
        next.rows[0]!.n,
        req.effectiveFrom,
        req.source,
        req.notes ?? null,
        checked.entries.length,
        checked.sha256,
        ctx.principal.subject,
      ],
    )
  ).rows[0]!;
  await tx.query(
    `INSERT INTO refdata.entries (version_id, key, data)
     SELECT $1, e.key, e.data FROM jsonb_to_recordset($2::jsonb) AS e(key text, data jsonb)`,
    [row.id, JSON.stringify(checked.entries)],
  );
  await writeAudit(tx, ctx, {
    action: 'refdata.version_loaded',
    resourceType: 'refdata_version',
    resourceId: row.id,
    data: {
      dataset,
      version: row.version,
      effectiveFrom: row.effective_from,
      entries: row.entry_count,
      source: row.source,
      sha256: row.sha256,
    },
  });
  return row;
}
