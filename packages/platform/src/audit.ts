import type { AuditVerification } from '@astra/contracts';
import type { RequestContext } from './context';
import type { Tx } from './db';

export interface AuditEntryInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  accountId?: string | null;
  reason?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Appends an audit record in the caller's transaction, so the record exists if and only if the
 * change it describes commits. Records are append-only and hashed by the database (see migration 0001).
 */
export async function writeAudit(
  tx: Tx,
  ctx: RequestContext,
  entry: AuditEntryInput,
): Promise<void> {
  const p = ctx.principal;
  await tx.query(
    `INSERT INTO audit.audit_log
       (actor_type, actor_id, actor_name, action, resource_type, resource_id, account_id,
        correlation_id, reason, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      p.kind,
      p.subject,
      p.name,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.accountId ?? null,
      ctx.correlationId,
      entry.reason ?? null,
      JSON.stringify(entry.data ?? {}),
    ],
  );
}

/** Seals audit rows older than `minAgeSeconds` into the hash chain. Returns the seal ID or null. */
export async function sealAudit(tx: Tx, minAgeSeconds = 120): Promise<string | null> {
  const { rows } = await tx.query<{ id: string | null }>(
    `SELECT audit.seal_pending(make_interval(secs => $1)) AS id`,
    [minAgeSeconds],
  );
  return rows[0]?.id ?? null;
}

export async function verifyAudit(tx: Tx): Promise<AuditVerification> {
  const { rows } = await tx.query<{
    ok: boolean;
    rows_checked: string;
    seals_checked: string;
    last_sealed_seq: string | null;
    mismatch_kind: 'row' | 'seal' | null;
    mismatch_ref: string | null;
  }>('SELECT * FROM audit.verify()');
  const r = rows[0];
  if (!r) throw new Error('audit.verify() returned no result');
  return {
    ok: r.ok,
    rowsChecked: Number(r.rows_checked),
    sealsChecked: Number(r.seals_checked),
    lastSealedSeq: r.last_sealed_seq,
    firstMismatch: r.mismatch_kind ? { kind: r.mismatch_kind, ref: r.mismatch_ref ?? '' } : null,
    checkedAt: new Date().toISOString(),
  };
}
