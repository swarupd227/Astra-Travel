import { createHash } from 'node:crypto';
import { AppError } from './errors';
import { canonicalJson } from './canonical-json';
import type { RequestContext } from './context';
import type { Tx } from './db';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const RETENTION_HOURS = 24;

export interface IdempotentRequest {
  key: string | undefined;
  method: string;
  path: string;
  body: unknown;
  /** The account the request acts for; null for platform-level requests. */
  accountId: string | null;
}

export interface IdempotentResponse<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Exactly-once execution for partner-facing writes (E04-F02-S01, E14-F01-S01).
 *
 * The key row is inserted in the same transaction as the business change. A concurrent request with
 * the same key blocks on the insert until the first transaction ends, then replays its stored
 * response. A key reused with a different request body is rejected. Failed requests roll back, so
 * their keys can be retried.
 */
export async function withIdempotency<T>(
  tx: Tx,
  ctx: RequestContext,
  req: IdempotentRequest,
  run: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResponse<T>> {
  if (!req.key) throw new AppError('idempotency_key_required');
  if (!IDEMPOTENCY_KEY_PATTERN.test(req.key)) {
    throw new AppError('validation_failed', 'Idempotency-Key must be 8 to 200 characters.', [
      {
        code: 'invalid_format',
        message: 'Use 8 to 200 letters, digits, ".", "_", ":" or "-".',
        field: 'Idempotency-Key',
      },
    ]);
  }
  const requestHash = createHash('sha256')
    .update(`${req.method.toUpperCase()} ${req.path}\n${canonicalJson(req.body ?? null)}`)
    .digest('hex');
  const principal = ctx.principal.subject;

  const inserted = await tx.query(
    `INSERT INTO platform.idempotency_keys
       (principal, key, account_id, method, path, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))
     ON CONFLICT (principal, key) DO NOTHING
     RETURNING 1`,
    [
      principal,
      req.key,
      req.accountId,
      req.method.toUpperCase(),
      req.path,
      requestHash,
      RETENTION_HOURS,
    ],
  );

  if (inserted.rowCount === 0) {
    const { rows } = await tx.query<{
      request_hash: string;
      response_status: number | null;
      response_body: T | null;
    }>(
      `SELECT request_hash, response_status, response_body
         FROM platform.idempotency_keys WHERE principal = $1 AND key = $2`,
      [principal, req.key],
    );
    const existing = rows[0];
    if (!existing || existing.response_status === null) {
      throw new AppError('idempotency_in_progress');
    }
    if (existing.request_hash !== requestHash) throw new AppError('idempotency_key_reused');
    return { status: existing.response_status, body: existing.response_body as T, replayed: true };
  }

  const result = await run();
  await tx.query(
    `UPDATE platform.idempotency_keys SET response_status = $3, response_body = $4
      WHERE principal = $1 AND key = $2`,
    [principal, req.key, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}

export async function purgeExpiredIdempotencyKeys(tx: Tx): Promise<number> {
  const res = await tx.query(
    `DELETE FROM platform.idempotency_keys WHERE ctid IN (
       SELECT ctid FROM platform.idempotency_keys WHERE expires_at < now() LIMIT 10000)`,
  );
  return res.rowCount ?? 0;
}
