import pg from 'pg';
import { accountScopeSetting, type RequestContext } from './context';
import { createLogger } from './logger';

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;

// Return bigint columns (int8) as strings and numeric as strings: never lose precision on money.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
// Return DATE as the YYYY-MM-DD string: a calendar date has no time zone, and Date objects would add one.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export interface PoolOptions {
  max?: number;
  applicationName?: string;
  /** How long to wait for a connection before giving up; 5 seconds unless a caller (such as a test) allows more. */
  connectionTimeoutMillis?: number;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
    application_name: opts.applicationName ?? 'astra',
  });
  const logger = createLogger(opts.applicationName ?? 'astra');
  // The pool listens for errors only on idle connections. Without this, the database ending a session that is in use
  // (its transaction time limit, a restart) would end the whole process. The query in hand, or the next one, still
  // fails, and the pool replaces the connection.
  pool.on('connect', (client) => {
    client.on('error', (err) => logger.warn({ err }, 'The database ended a connection'));
  });
  return pool;
}

/**
 * Runs `fn` in a database transaction scoped to the caller. The account scope is written to
 * `app.account_ids`, which every row-level security policy reads, so account isolation is enforced by
 * the database itself and not only by application code (E13-F02-S03).
 */
export async function withTx<T>(
  pool: Pool,
  ctx: RequestContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.account_ids', $1, true),
              set_config('app.actor', $2, true),
              set_config('app.correlation_id', $3, true)`,
      [accountScopeSetting(ctx.principal.accountScope), ctx.principal.subject, ctx.correlationId],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

/** Opaque keyset cursor over (timestamp, id) or (seq). */
export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, arity: number): string[] | null {
  if (!cursor) return null;
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parts) || parts.length !== arity) return null;
    return parts.map((p) => String(p));
  } catch {
    return null;
  }
}
