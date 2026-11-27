import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DATA_CATALOGUE, type DataEntity, type DataLoad } from '@astra/contracts';
import type { RequestContext } from './context';
import { withTx, type Pool, type Tx } from './db';
import type { FileStore } from './file-store';

/**
 * Loads changes to the data platform (E12-F01-S02): every policy transaction and premium record not yet loaded, with
 * the rows of the reporting model they touch, as one newline-delimited JSON file per entity. Each load is checked;
 * a row that fails a check is left out and listed with the reason. Personal fields never leave. Sandbox accounts are
 * synthetic and are not loaded. Design: docs/adr/0018.
 */

export const DATA_LOAD_TARGET_SECONDS = 15 * 60;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

type Row = Record<string, unknown>;

const entity = (name: DataEntity['name']) => DATA_CATALOGUE.find((e) => e.name === name)!;

/** Reads rows of one reporting view as JSON, business fields only; amounts stay as exact text. */
async function read(
  tx: Tx,
  name: DataEntity['name'],
  where: string,
  params: unknown[],
): Promise<Row[]> {
  const e = entity(name);
  const cols = e.fields
    .filter((x) => x.classification === 'business')
    .map((x) => `'${x.name}', v.${x.name}${x.type === 'decimal' ? '::text' : ''}`)
    .join(', ');
  const { rows } = await tx.query<{ r: Row }>(
    `SELECT jsonb_build_object(${cols}) AS r FROM analytics.${name} v WHERE ${where} ORDER BY ${e.key.map((k) => `v.${k}`).join(', ')}`,
    params,
  );
  return rows.map((x) => x.r);
}

const keyOf = (e: DataEntity, r: Row) => e.key.map((k) => String(r[k])).join('/');
const cents = (v: unknown) => Math.round(Number(v) * 100);

export interface CheckedLoad {
  files: Map<DataEntity['name'], Row[]>;
  rejects: { entity: string; key: string; reason: string }[];
  checks: DataLoad['checks'];
}

/** The quality checks run on each load. A failing row is moved to the rejects with the first reason found. */
export function checkRows(
  input: Map<DataEntity['name'], Row[]>,
  knownPolicies: Set<string>,
): CheckedLoad {
  const rejects: CheckedLoad['rejects'] = [];
  const failures: Record<string, number> = {
    required_fields: 0,
    unique_keys: 0,
    references: 0,
    premium_lines: 0,
    trip_dates: 0,
  };
  const files = new Map<DataEntity['name'], Row[]>();
  const policies = new Set([
    ...knownPolicies,
    ...(input.get('policies') ?? []).map((r) => String(r.policy_id)),
  ]);
  for (const [name, rows] of input) {
    const e = entity(name);
    const seen = new Set<string>();
    const good: Row[] = [];
    for (const r of rows) {
      const key = keyOf(e, r);
      const fail = (check: keyof typeof failures, reason: string) => {
        failures[check] = (failures[check] ?? 0) + 1;
        rejects.push({ entity: name, key, reason });
      };
      const missing = e.fields.filter(
        (x) =>
          x.required &&
          x.classification === 'business' &&
          (r[x.name] === null || r[x.name] === undefined || r[x.name] === ''),
      );
      if (missing.length)
        fail('required_fields', `Missing ${missing.map((x) => x.name).join(', ')}.`);
      else if (seen.has(key)) fail('unique_keys', 'The same key appears twice.');
      else if (
        name !== 'policies' &&
        r.policy_id !== null &&
        r.policy_id !== undefined &&
        !policies.has(String(r.policy_id))
      )
        fail('references', 'The policy it belongs to is not in the model.');
      else if (
        name === 'premiums' &&
        Array.isArray(r.per_benefit) &&
        r.per_benefit.length > 0 &&
        (r.per_benefit as { premium: string }[]).reduce((a, x) => a + cents(x.premium), 0) !==
          cents(r.premium)
      )
        fail('premium_lines', 'The benefit lines do not add up to the premium.');
      else if (name === 'trips' && String(r.return_date) < String(r.departure_date))
        fail('trip_dates', 'The return date is before the departure date.');
      else {
        seen.add(key);
        good.push(r);
      }
    }
    files.set(name, good);
  }
  const describe: Record<string, string> = {
    required_fields: 'Every required field has a value',
    unique_keys: 'No key appears twice',
    references: 'Every row belongs to a policy in the model',
    premium_lines: 'Benefit lines add up to each premium',
    trip_dates: 'No trip returns before it departs',
  };
  return {
    files,
    rejects,
    checks: Object.entries(failures).map(([name, n]) => ({
      name,
      passed: n === 0,
      detail:
        n === 0
          ? describe[name]!
          : `${describe[name]!}: ${n} row(s) failed and are listed in the rejects.`,
    })),
  };
}

const PENDING_EVENTS = `FROM policies.policy_events e JOIN platform.accounts a ON a.id = e.account_id
   WHERE NOT a.sandbox AND NOT EXISTS (SELECT 1 FROM integration.data_load_items i WHERE i.item_key = 'transaction:' || e.seq)`;
// A premium record is loaded again when billing moves it to another status.
const PENDING_PREMIUMS = `FROM billing.premium_records r
   WHERE NOT EXISTS (SELECT 1 FROM integration.data_load_items i WHERE i.item_key = 'premium:' || r.id || ':' || r.status)`;
const NEW_PREMIUM = `NOT EXISTS (SELECT 1 FROM integration.data_load_items i WHERE i.item_key LIKE 'premium:' || r.id || ':%')`;

/** What is waiting to be loaded and how long the oldest new change has waited. */
export async function pendingLoad(
  tx: Tx,
): Promise<{ count: number; oldestSeconds: number | null; withinTarget: boolean }> {
  const r = (
    await tx.query<{ n: string; oldest: string | null }>(
      `SELECT count(*) AS n, floor(extract(epoch FROM now() - min(at))) AS oldest FROM (
         SELECT e.occurred_at AS at ${PENDING_EVENTS}
         UNION ALL
         SELECT CASE WHEN ${NEW_PREMIUM} THEN r.occurred_at END ${PENDING_PREMIUMS}
       ) x`,
    )
  ).rows[0]!;
  const oldest = r.oldest === null ? null : Math.max(0, Number(r.oldest));
  return {
    count: Number(r.n),
    oldestSeconds: oldest,
    withinTarget: oldest === null || oldest <= DATA_LOAD_TARGET_SECONDS,
  };
}

/** Makes one load of up to `limit` changes. Returns null when nothing is waiting. */
export async function runDataLoad(
  pool: Pool,
  ctx: RequestContext,
  store: FileStore,
  opts: { trigger: 'schedule' | 'manual'; limit?: number },
): Promise<{ load: DataLoad; more: boolean } | null> {
  const limit = opts.limit ?? 2000;
  return withTx(pool, ctx, async (tx) => {
    // One load at a time, so no change is taken twice.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('astra:data-load'))`);
    const events = (
      await tx.query<{ seq: string; policy_id: string; lag: string }>(
        `SELECT e.seq, e.policy_id, floor(extract(epoch FROM now() - e.occurred_at)) AS lag ${PENDING_EVENTS} ORDER BY e.seq LIMIT $1`,
        [limit],
      )
    ).rows;
    const premiums = (
      await tx.query<{ id: string; status: string; policy_id: string | null; lag: string | null }>(
        `SELECT r.id, r.status, r.policy_id, CASE WHEN ${NEW_PREMIUM} THEN floor(extract(epoch FROM now() - r.occurred_at)) END AS lag ${PENDING_PREMIUMS}
            AND NOT EXISTS (SELECT 1 FROM platform.accounts a WHERE a.id = r.account_id AND a.sandbox)
          ORDER BY r.occurred_at, r.id LIMIT $1`,
        [limit],
      )
    ).rows;
    if (events.length === 0 && premiums.length === 0) return null;

    const policyIds = [
      ...new Set([
        ...events.map((e) => e.policy_id),
        ...premiums.flatMap((p) => (p.policy_id ? [p.policy_id] : [])),
      ]),
    ];
    const input = new Map<DataEntity['name'], Row[]>();
    input.set(
      'policies',
      await read(tx, 'policies', 'v.policy_id = ANY ($1::uuid[])', [policyIds]),
    );
    for (const name of ['travellers', 'trips', 'benefits'] as const)
      input.set(name, await read(tx, name, 'v.policy_id = ANY ($1::uuid[])', [policyIds]));
    input.set(
      'transactions',
      await read(tx, 'transactions', 'v.transaction_id = ANY ($1::bigint[])', [
        events.map((e) => e.seq),
      ]),
    );
    input.set(
      'premiums',
      await read(tx, 'premiums', 'v.premium_id = ANY ($1::uuid[])', [premiums.map((p) => p.id)]),
    );
    const planIds = [...new Set((input.get('policies') ?? []).map((r) => String(r.plan_id)))];
    const accountIds = [
      ...new Set([
        ...(input.get('policies') ?? []).map((r) => String(r.account_id)),
        ...(input.get('premiums') ?? []).map((r) => String(r.account_id)),
      ]),
    ];
    input.set('plans', await read(tx, 'plans', 'v.plan_id = ANY ($1::uuid[])', [planIds]));
    input.set(
      'accounts',
      await read(tx, 'accounts', 'v.account_id = ANY ($1::uuid[])', [accountIds]),
    );

    const checked = checkRows(input, new Set());
    const id = randomUUID();
    const files: DataLoad['files'] = [];
    const write = async (name: string, rows: unknown[]) => {
      if (rows.length === 0) return;
      const body = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      await store.put(`data-platform/${id}/${name}`, Readable.from(body), MAX_FILE_BYTES);
      files.push({
        name,
        rows: rows.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: body.length,
      });
    };
    for (const e of DATA_CATALOGUE)
      await write(`${e.name}.ndjson`, checked.files.get(e.name) ?? []);
    await write('rejects.ndjson', checked.rejects);

    const items = [
      ...events.map((e) => `transaction:${e.seq}`),
      ...premiums.map((p) => `premium:${p.id}:${p.status}`),
    ];
    const lag = Math.max(
      0,
      ...events.map((e) => Number(e.lag)),
      ...premiums.map((p) => Number(p.lag ?? 0)),
    );
    const row = (
      await tx.query<{ number: string; started_at: Date }>(
        `INSERT INTO integration.data_loads (id, status, trigger, requested_by, items, rejected, max_lag_seconds, checks, files)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING number, started_at`,
        [
          id,
          checked.rejects.length ? 'with_rejects' : 'delivered',
          opts.trigger,
          ctx.principal.subject,
          items.length,
          checked.rejects.length,
          lag,
          JSON.stringify(checked.checks),
          JSON.stringify(files),
        ],
      )
    ).rows[0]!;
    await tx.query(
      `INSERT INTO integration.data_load_items (item_key, load_id) SELECT k, $2 FROM unnest($1::text[]) k ON CONFLICT (item_key) DO NOTHING`,
      [items, id],
    );
    return {
      load: {
        id,
        number: Number(row.number),
        startedAt: row.started_at.toISOString(),
        status: checked.rejects.length ? ('with_rejects' as const) : ('delivered' as const),
        trigger: opts.trigger,
        items: items.length,
        rejected: checked.rejects.length,
        maxLagSeconds: lag,
        checks: checked.checks,
        files,
      },
      more: events.length === limit || premiums.length === limit,
    };
  });
}
