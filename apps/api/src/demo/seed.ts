/**
 * Loads the sample data set into a development environment (docs/operations/sample-data.md).
 *
 * It runs only when asked in so many words (ASTRA_SAMPLE_DATA=load), because everything it creates is invented and
 * must never sit beside real business. It adds and never deletes, and a second run carries on where one stopped.
 */
import { systemContext, withTx } from '@astra/platform';
import { startClient } from './client';
import { runBusiness, type Size } from './business';
import { seeded } from './random';
import { configureProduct } from './setup';

const log = (message: string) =>
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`);

const amount = (name: string, otherwise: number) => {
  const value = Number(process.env[name] ?? otherwise);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number.`);
  return value;
};

if (process.env.ASTRA_SAMPLE_DATA !== 'load') {
  throw new Error(
    'Sample data is invented and is for development environments only. Set ASTRA_SAMPLE_DATA=load to load it.',
  );
}

const size: Size = {
  policies: amount('SAMPLE_POLICIES', 2500),
  openQuotes: amount('SAMPLE_OPEN_QUOTES', 450),
  cardholdersPerProgramme: amount('SAMPLE_CARDHOLDERS', 40_000),
  concurrency: Math.max(1, amount('SAMPLE_CONCURRENCY', 6)),
};

const client = await startClient(process.env);
try {
  // A database that holds business this loader did not create is left alone.
  const foreign = await withTx(client.pool, systemContext('sample-data'), async (tx) => {
    const { rows } = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM policies.policies p JOIN platform.accounts a ON a.id = p.account_id
        WHERE a.name NOT LIKE '%(sample)%'`,
    );
    return Number(rows[0]!.n);
  });
  if (foreign > 0) {
    throw new Error(
      `This database holds ${foreign} policies of accounts that are not sample accounts. Nothing was loaded.`,
    );
  }
  log(`loading: ${JSON.stringify(size)}`);
  const plans = await configureProduct(client, log);
  await runBusiness(client, log, seeded(20261127), plans, size);
  const held = await withTx(client.pool, systemContext('sample-data'), async (tx) => {
    const { rows } = await tx.query<{ what: string; n: string }>(
      `SELECT 'accounts' AS what, count(*) AS n FROM platform.accounts WHERE NOT sandbox
       UNION ALL SELECT 'published plans', count(*) FROM plans.plan_versions WHERE status = 'published'
       UNION ALL SELECT 'published rate manuals', count(*) FROM rating.manuals WHERE status = 'published'
       UNION ALL SELECT 'quotes', count(*) FROM policies.quotes
       UNION ALL SELECT 'policies', count(*) FROM policies.policies
       UNION ALL SELECT 'cancelled policies', count(*) FROM policies.policies WHERE status = 'cancelled'
       UNION ALL SELECT 'documents', count(*) FROM documents.documents
       UNION ALL SELECT 'premium records', count(*) FROM billing.premium_records
       UNION ALL SELECT 'open referrals', count(*) FROM underwriting.referrals WHERE status = 'open'
       UNION ALL SELECT 'card programmes', count(*) FROM card.programmes`,
    );
    return rows;
  });
  for (const row of held) log(`held: ${row.n} ${row.what}`);
  log('SAMPLE DATA LOADED');
} finally {
  await client.close();
}
