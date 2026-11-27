import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { ControlTotals } from '@astra/contracts';
import {
  fromCents,
  headerLine,
  trailerLine,
  totalsOf,
  type TotalsAccumulator,
} from '@astra/billing';
import type { FileStore, Tx } from '@astra/platform';

/**
 * Building a batch (E08-F03, E08-F04-S01): takes each ready record once, writes the batch file as a stream with
 * its control totals, and records its hash. Records are read in pages, so volume is limited by throughput and
 * not by memory. Design: docs/adr/0013.
 */

const PAGE = 5_000;

export interface BuiltBatch {
  id: string;
  number: number;
  totals: ControlTotals;
  sha256: string;
  sizeBytes: number;
}

interface Row {
  id: string;
  number: string;
  type: string;
  account_id: string;
  policy_id: string | null;
  policy_number: string | null;
  programme_id: string | null;
  period: string | null;
  state: string | null;
  policy_event_seq: string | null;
  premium_cents: string;
  charge_cents: string;
  refund_cents: string;
  retained_cents: string;
  commission_cents: string | null;
  tax_cents: string | null;
  per_benefit: unknown;
  per_traveller: unknown;
  allocation: unknown;
  commission: unknown;
  basis: unknown;
  worksheet_ids: string[];
  occurred_at: Date;
}

const money = (v: string | null) => (v === null ? null : fromCents(Number(v)));

const toLine = (r: Row) =>
  JSON.stringify({
    type: 'record',
    id: r.id,
    number: r.number,
    recordType: r.type,
    accountId: r.account_id,
    policyId: r.policy_id,
    policyNumber: r.policy_number,
    policyEventSeq: r.policy_event_seq === null ? null : Number(r.policy_event_seq),
    programmeId: r.programme_id,
    period: r.period,
    state: r.state,
    occurredAt: r.occurred_at.toISOString(),
    premium: money(r.premium_cents),
    charge: money(r.charge_cents),
    refund: money(r.refund_cents),
    retained: money(r.retained_cents),
    commission: money(r.commission_cents),
    tax: money(r.tax_cents),
    perBenefit: r.per_benefit,
    perTraveller: r.per_traveller,
    allocation: r.allocation,
    commissionDetail: r.commission,
    basis: r.basis,
    worksheetIds: r.worksheet_ids,
  });

/** Claims up to `limit` ready records for a new batch and writes its file. Returns null when nothing is ready. */
export async function buildBatch(
  tx: Tx,
  files: FileStore,
  createdBy: string,
  limit: number,
): Promise<BuiltBatch | null> {
  const id = randomUUID();
  const claimed = await tx.query<{ id: string }>(
    `WITH picked AS (
       SELECT id FROM billing.premium_records WHERE status = 'ready' AND batch_id IS NULL ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     ) SELECT id FROM picked`,
    [limit],
  );
  if (claimed.rowCount === 0) return null;
  const agg = (
    await tx.query<{
      count: string;
      premium: string;
      charges: string;
      refunds: string;
      commission: string;
      tax: string;
    }>(
      `SELECT count(*)::text AS count, coalesce(sum(premium_cents), 0)::text AS premium, coalesce(sum(charge_cents), 0)::text AS charges, coalesce(sum(refund_cents), 0)::text AS refunds,
              coalesce(sum(commission_cents), 0)::text AS commission, coalesce(sum(tax_cents), 0)::text AS tax
         FROM billing.premium_records WHERE id = ANY ($1::uuid[])`,
      [claimed.rows.map((r) => r.id)],
    )
  ).rows[0]!;
  const acc: TotalsAccumulator = {
    count: Number(agg.count),
    premium: Number(agg.premium),
    charges: Number(agg.charges),
    refunds: Number(agg.refunds),
    commission: Number(agg.commission),
    tax: Number(agg.tax),
  };
  const totals = totalsOf(acc);
  const key = `billing/${id}.ndjson`;
  const batch = (
    await tx.query<{ number: string }>(
      `INSERT INTO billing.batches (id, status, totals, file_key, sha256, size_bytes, created_by) VALUES ($1, 'ready', $2, $3, '', 0, $4) RETURNING number`,
      [id, JSON.stringify(totals), key, createdBy],
    )
  ).rows[0]!;
  const number = Number(batch.number);
  await tx.query(
    `UPDATE billing.premium_records SET status = 'batched', batch_id = $2 WHERE id = ANY ($1::uuid[])`,
    [claimed.rows.map((r) => r.id), id],
  );

  // Stream the file: header, one line per record in number order, trailer.
  const out = new PassThrough();
  const written = files.put(key, out, 4 * 1024 * 1024 * 1024);
  const write = (s: string) =>
    new Promise<void>((resolve, reject) => {
      if (out.write(`${s}\n`)) resolve();
      else out.once('drain', resolve).once('error', reject);
    });
  try {
    await write(headerLine({ batchId: id, number, createdAt: new Date().toISOString() }, totals));
    let after = '';
    for (;;) {
      const { rows } = await tx.query<Row>(
        `SELECT r.id, r.number, r.type, r.account_id, r.policy_id, p.number AS policy_number, r.programme_id, r.period, r.state, r.policy_event_seq::text, r.premium_cents::text, r.charge_cents::text, r.refund_cents::text,
                r.retained_cents::text, r.commission_cents::text, r.tax_cents::text, r.per_benefit, r.per_traveller, r.allocation, r.commission, r.basis, r.worksheet_ids, r.occurred_at
           FROM billing.premium_records r LEFT JOIN policies.policies p ON p.id = r.policy_id
          WHERE r.batch_id = $1 AND r.number > $2 ORDER BY r.number LIMIT $3`,
        [id, after, PAGE],
      );
      if (rows.length === 0) break;
      await write(rows.map(toLine).join('\n'));
      after = rows.at(-1)!.number;
    }
    await write(trailerLine(totals));
    out.end();
  } catch (err) {
    out.destroy(err instanceof Error ? err : new Error(String(err)));
    await written.catch(() => undefined);
    throw err;
  }
  const stored = await written;
  await tx.query(`UPDATE billing.batches SET sha256 = $2, size_bytes = $3 WHERE id = $1`, [
    id,
    stored.sha256,
    stored.sizeBytes,
  ]);
  return { id, number, totals, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
}
