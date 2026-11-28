/**
 * The database ends a session whose transaction runs too long. The request in hand fails; the process, and the pool,
 * carry on.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, systemContext, withTx } from '@astra/platform';
import { requireEnv } from './helpers';

const pool = createPool(requireEnv('TEST_DATABASE_URL'), {
  max: 1,
  connectionTimeoutMillis: 60_000,
});
afterAll(async () => pool.end());

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('a transaction the database ends for running too long', () => {
  it('fails that piece of work only', async () => {
    // On the pool's one connection, before the transaction begins, which is when the timer is set.
    await pool.query(`SET transaction_timeout = '200ms'`);
    await expect(
      withTx(pool, systemContext('test'), async (tx) => {
        // Busy elsewhere, with no query running, when the database hangs up.
        await wait(1_000);
        await tx.query('SELECT 1');
      }),
    ).rejects.toThrow();
    // The lost connection is replaced.
    const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);
  });
});
