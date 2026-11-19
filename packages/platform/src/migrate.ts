import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Applies ordered SQL migrations as the schema owner. Each file runs in its own transaction.
 * A migration that was already applied must not change: its checksum is verified on every run.
 * A cluster-wide advisory lock prevents two deployments from migrating at once.
 */
export async function migrate(
  connectionString: string,
  dir: string,
  log: (msg: string) => void = () => undefined,
): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = new pg.Client({ connectionString, application_name: 'astra-migrate' });
  await client.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('astra.migrate'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM public.schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const result: MigrationResult = { applied: [], alreadyApplied: 0 };

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const existing = applied.get(file);
      if (existing) {
        if (existing !== checksum) {
          throw new Error(
            `Migration ${file} was changed after it was applied. Add a new migration instead.`,
          );
        }
        result.alreadyApplied += 1;
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client
      .query(`SELECT pg_advisory_unlock(hashtext('astra.migrate'))`)
      .catch(() => undefined);
    await client.end();
  }
}
