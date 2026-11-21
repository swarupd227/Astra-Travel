// Load test for eligibility feed processing (E21-F02-S01): a full feed of N accounts, then a change feed,
// through the same FeedProcessor the worker runs, against the local database. Synthetic data only, in a
// dedicated LOADTEST account; never run against a shared or production environment.
//
//   node --env-file=.env --import tsx scripts/card-feed-load.ts [accounts=1000000] [changes=100000]
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FeedProcessor } from '@astra/card';
import { createLogger, createPool, LocalFileStore, systemContext, withTx } from '@astra/platform';

const accounts = Number(process.argv[2] ?? 1_000_000);
const changes = Number(process.argv[3] ?? 100_000);
if (process.env.NODE_ENV === 'production')
  throw new Error('Never run the load test in production.');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const pool = createPool(url, { max: 4, applicationName: 'astra-card-load' });
const root = join(tmpdir(), `astra-card-load-${randomUUID()}`);
mkdirSync(root, { recursive: true });
const store = new LocalFileStore(root);
const processor = new FeedProcessor(pool, store, createLogger('card-load', 'warn'));
const ctx = systemContext('card-load-test');
const code = `LOAD-${Date.now().toString(36).toUpperCase()}`;

async function writeFeed(name: string, lines: Iterable<string>): Promise<string> {
  const path = join(root, name);
  const out = createWriteStream(path);
  for (const line of lines) {
    if (!out.write(`${line}\n`)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  return path;
}

function* fullFeed() {
  yield `H|ASTRA-ELIG|1|${code}|1|FULL|2026-11-01`;
  for (let i = 0; i < accounts; i++)
    yield `D|tok_${i.toString(36).padStart(8, '0')}|${i % 3 === 0 ? 'GOLD' : 'PLAT'}|A|2025-01-01|`;
  yield `T|${accounts}|${accounts}|0|0`;
}

function* changeFeed() {
  const adds = Math.floor(changes * 0.4);
  const updates = Math.floor(changes * 0.4);
  const removes = changes - adds - updates;
  yield `H|ASTRA-ELIG|1|${code}|2|CHANGE|2026-11-15`;
  for (let i = 0; i < adds; i++)
    yield `D|new_${i.toString(36).padStart(8, '0')}|PLAT|A|2026-11-15|`;
  for (let i = 0; i < updates; i++)
    yield `D|tok_${(i * 2).toString(36).padStart(8, '0')}|BLACK|U|2025-01-01|`;
  for (let i = 0; i < removes; i++)
    yield `D|tok_${(i * 2 + 1).toString(36).padStart(8, '0')}|PLAT|D|2025-01-01|2026-11-30`;
  yield `T|${changes}|${adds}|${updates}|${removes}`;
}

async function upload(programmeId: string, accountId: string, file: string, name: string) {
  const { createReadStream } = await import('node:fs');
  const stored = await store.put(
    `card-feeds/${programmeId}/${randomUUID()}.txt`,
    createReadStream(file),
    8 * 1024 ** 3,
  );
  return withTx(pool, ctx, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO card.feeds (programme_id, account_id, mode, file_name, storage_key, sha256, size_bytes, received_by)
       VALUES ($1, $2, 'live', $3, $4, $5, $6, 'card-load-test') RETURNING id`,
      [programmeId, accountId, name, stored.key, stored.sha256, stored.sizeBytes],
    );
    return { id: rows[0]!.id, bytes: stored.sizeBytes };
  });
}

async function run(programmeId: string, accountId: string, file: string, name: string) {
  const { id, bytes } = await upload(programmeId, accountId, file, name);
  const claimed = await processor.claimNext();
  if (claimed !== id)
    throw new Error(
      `Expected to claim ${id}, got ${claimed}. Is a worker running against this database?`,
    );
  const started = performance.now();
  const outcome = await processor.process(id);
  const seconds = (performance.now() - started) / 1000;
  return { name, bytes, seconds, outcome };
}

try {
  const { programmeId, accountId } = await withTx(pool, ctx, async (tx) => {
    const account = await tx.query<{ id: string }>(
      `INSERT INTO platform.accounts (code, name, kind, created_by) VALUES ($1, $2, 'bank', 'card-load-test') RETURNING id`,
      [code, `${code} load test bank (synthetic)`],
    );
    const accountId = account.rows[0]!.id;
    const mp = await tx.query<{ id: string }>(
      `INSERT INTO card.master_policies (account_id, policy_number, underwriter, states, effective_from, created_by)
       VALUES ($1, $2, 'VSC', '{NY}', '2025-01-01', 'card-load-test') RETURNING id`,
      [accountId, `MP-${code}`],
    );
    const p = await tx.query<{ id: string }>(
      `INSERT INTO card.programmes (account_id, master_policy_id, code, name, card_product, states, effective_from,
                                    payment_condition, eligibility_rule, max_reject_percent, status, created_by)
       VALUES ($1, $2, $3, 'Load test programme', 'Platinum', '{NY}', '2025-01-01', '{"rule":"none"}',
               'purchase_date', 1, 'live', 'card-load-test') RETURNING id`,
      [accountId, mp.rows[0]!.id, code],
    );
    return { programmeId: p.rows[0]!.id, accountId };
  });

  console.log(
    `Programme ${code}: generating a full feed of ${accounts.toLocaleString('en-US')} accounts…`,
  );
  const full = await writeFeed('full.txt', fullFeed());
  const r1 = await run(programmeId, accountId, full, 'full.txt');
  console.log(
    r1.outcome.status === 'applied'
      ? 'applied'
      : `NOT APPLIED: ${r1.outcome.status} ${r1.outcome.reason}`,
  );

  const change = await writeFeed('change.txt', changeFeed());
  const r2 = await run(programmeId, accountId, change, 'change.txt');
  console.log(
    r2.outcome.status === 'applied'
      ? 'applied'
      : `NOT APPLIED: ${r2.outcome.status} ${r2.outcome.reason}`,
  );

  const lookups = await withTx(pool, ctx, async (tx) => {
    const started = performance.now();
    const n = 1000;
    for (let i = 0; i < n; i++) {
      const ref = `tok_${Math.floor(Math.random() * accounts)
        .toString(36)
        .padStart(8, '0')}`;
      await tx.query(
        `SELECT 1 FROM card.eligibility_periods WHERE programme_id = $1 AND account_ref = $2
            AND valid_from <= '2026-11-20' AND (valid_to IS NULL OR valid_to > '2026-11-20') LIMIT 1`,
        [programmeId, ref],
      );
    }
    return (performance.now() - started) / n;
  });

  console.log('\nResults (this machine):');
  for (const r of [r1, r2]) {
    const s = r.outcome.stats!;
    console.log(
      `  ${r.name.padEnd(11)} ${(r.bytes / 1024 ** 2).toFixed(1).padStart(6)} MB  ${r.seconds.toFixed(1).padStart(6)} s  ` +
        `${Math.round(s.detailRecords / r.seconds)
          .toLocaleString('en-US')
          .padStart(8)} records/s  ` +
        `added ${s.added.toLocaleString('en-US')}, updated ${s.updated.toLocaleString('en-US')}, removed ${s.removed.toLocaleString('en-US')}, ` +
        `rejected ${s.rejectedRecords}, certificates ${s.certificatesIssued.toLocaleString('en-US')}`,
    );
    const phases = Object.entries(r.outcome.phases ?? {}).map(
      ([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`,
    );
    console.log(`              phases: ${phases.join(', ')}`);
  }
  console.log(`  eligibility lookup: ${lookups.toFixed(2)} ms average over 1,000 random accounts`);
  await withTx(pool, ctx, (tx) =>
    tx.query(
      `UPDATE card.programmes SET status = 'closed', status_reason = 'Synthetic load-test programme', updated_at = now()
        WHERE id = $1`,
      [programmeId],
    ),
  );
  console.log(
    `\nThe ${code} programme stays in the local database, closed, so its data can be inspected.`,
  );
} finally {
  await pool.end();
  rmSync(root, { recursive: true, force: true });
}
