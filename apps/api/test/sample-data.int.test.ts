/**
 * The sample data loader still works against the platform as it is: a very small load on an empty test database, and
 * a second run that carries on. Everything it creates is invented.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext, withTx } from '@astra/platform';
import { runBusiness } from '../src/demo/business';
import { startClient, type Client } from '../src/demo/client';
import { seeded } from '../src/demo/random';
import { configureProduct } from '../src/demo/setup';
import { requireEnv, resetDatabase } from './helpers';

let client: Client;
const files = mkdtempSync(join(tmpdir(), 'astra-sample-'));

beforeAll(async () => {
  await resetDatabase();
  client = await startClient({
    NODE_ENV: 'test',
    DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
    SECRETS_KEK_ID: 'test',
    SECRETS_KEK: randomBytes(32).toString('base64'),
    FILE_STORE_DIR: files,
  });
}, 60_000);
afterAll(async () => {
  await client?.close();
  rmSync(files, { recursive: true, force: true });
});

const count = (sql: string) =>
  withTx(client.pool, systemContext('test'), async (tx) =>
    Number((await tx.query<{ n: string }>(sql)).rows[0]!.n),
  );

describe('sample data', () => {
  it('loads the product, accounts, card programmes and sales, and can be run again', async () => {
    const size = { policies: 24, openQuotes: 6, cardholdersPerProgramme: 40, concurrency: 4 };
    const log = () => undefined;
    const plans = await configureProduct(client, log);
    expect(plans).toHaveLength(16);
    await runBusiness(client, log, seeded(1), plans, size);
    const policies = () =>
      count(
        `SELECT count(*) AS n FROM policies.policies p JOIN platform.accounts a ON a.id = p.account_id
          WHERE NOT a.sandbox AND a.name LIKE '%(sample)%'`,
      );
    expect(await policies()).toBeGreaterThanOrEqual(18);
    expect(
      await count(
        `SELECT count(*) AS n FROM platform.accounts WHERE status = 'active' AND NOT sandbox`,
      ),
    ).toBeGreaterThanOrEqual(19);
    expect(await count(`SELECT count(*) AS n FROM card.programmes WHERE status = 'live'`)).toBe(5);

    const again = await configureProduct(client, log);
    expect(again.map((p) => p.versionId)).toEqual(plans.map((p) => p.versionId));
    await runBusiness(client, log, seeded(1), again, { ...size, policies: 30 });
    expect(await policies()).toBeGreaterThanOrEqual(24);
    expect(await count(`SELECT count(*) AS n FROM card.programmes`)).toBe(5);
  }, 600_000);
});
