import { createInterface } from 'node:readline';
import { EligibilityFeedLoaded, type FeedStats } from '@astra/contracts';
import {
  publishEvent,
  systemContext,
  withTx,
  writeAudit,
  type FileStore,
  type Logger,
  type Pool,
  type RequestContext,
  type Tx,
} from '@astra/platform';
import { parseFeed, type FeedRecord, type RecordRejection } from './parser';

/**
 * Eligibility feed processing (E21-F02-S01). Exactly once per file, strictly in sequence, and only when
 * the file passes its control checks; otherwise the feed is held and the previous eligibility stays in
 * force. Records are staged and applied with set-based SQL so that large bank programmes fit the window.
 */

const BATCH = 10_000;

interface FeedRow {
  id: string;
  programme_id: string;
  account_id: string;
  mode: 'live' | 'test';
  status: string;
  storage_key: string;
  sequence: number | null;
  kind: 'FULL' | 'CHANGE' | null;
  as_of_date: string | null;
  stats: FeedStats | null;
}

interface ProgrammeRow {
  id: string;
  code: string;
  status: string;
  max_reject_percent: string;
  last_applied_sequence: number;
}

export interface ProcessOutcome {
  status: 'waiting' | 'applied' | 'held' | 'rejected' | 'passed' | 'failed';
  reason: string | null;
  stats: FeedStats | null;
  /** Milliseconds per processing phase, for capacity planning. */
  phases?: Record<string, number>;
}

const emptyStats = (): FeedStats => ({
  detailRecords: 0,
  rejectedRecords: 0,
  added: 0,
  updated: 0,
  removed: 0,
  unchanged: 0,
  certificatesIssued: 0,
});

export class FeedProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly store: FileStore,
    private readonly logger: Logger,
  ) {}

  /** Claims a received feed, or a waiting live feed whose predecessor has now been applied. */
  async claimNext(): Promise<string | null> {
    const { rows } = await withTx(this.pool, systemContext('eligibility-feeds'), (tx) =>
      tx.query<{ id: string }>(
        `UPDATE card.feeds SET locked_until = now() + interval '2 hours'
          WHERE id = (SELECT f.id FROM card.feeds f JOIN card.programmes p ON p.id = f.programme_id
                       WHERE (f.locked_until IS NULL OR f.locked_until < now())
                         AND (f.status = 'received'
                              OR (f.status = 'waiting' AND f.sequence = p.last_applied_sequence + 1))
                       ORDER BY f.received_at
                       FOR UPDATE OF f SKIP LOCKED LIMIT 1)
          RETURNING id`,
      ),
    );
    return rows[0]?.id ?? null;
  }

  async process(feedId: string): Promise<ProcessOutcome> {
    const started = Date.now();
    const phases: Record<string, number> = {};
    const ctx = systemContext('eligibility-feeds');
    const { feed, programme } = await withTx(this.pool, ctx, async (tx) => ({
      feed: (await tx.query<FeedRow>(`SELECT * FROM card.feeds WHERE id = $1`, [feedId])).rows[0]!,
      programme: (
        await tx.query<ProgrammeRow>(
          `SELECT p.id, p.code, p.status, p.max_reject_percent, p.last_applied_sequence
             FROM card.programmes p JOIN card.feeds f ON f.programme_id = p.id WHERE f.id = $1`,
          [feedId],
        )
      ).rows[0]!,
    }));

    let stats = feed.stats ?? emptyStats();
    let header = { sequence: feed.sequence, kind: feed.kind, asOfDate: feed.as_of_date };

    // Staging is unlogged: after a database crash a waiting feed's records are gone, so stage it again.
    if (feed.status === 'waiting' && stats.detailRecords > stats.rejectedRecords) {
      const staged = await withTx(this.pool, ctx, (tx) =>
        tx.query(`SELECT 1 FROM card.feed_records WHERE feed_id = $1 LIMIT 1`, [feed.id]),
      );
      if (!staged.rowCount) feed.status = 'received';
    }

    if (feed.status === 'received') {
      const stageStarted = Date.now();
      const parsed = await this.stage(feed);
      phases.stage = Date.now() - stageStarted;
      stats = {
        ...emptyStats(),
        detailRecords: parsed.detailRecords,
        rejectedRecords: parsed.rejected,
      };
      const h = parsed.header;
      const failed = feed.mode === 'live' ? 'held' : 'failed';
      if (h) {
        header = { sequence: h.sequence, kind: h.kind, asOfDate: h.asOfDate };
        // Recorded even when the rest of the file is broken, so a held feed keeps its sequence.
        await withTx(this.pool, ctx, (tx) =>
          tx.query(
            `UPDATE card.feeds SET sequence = $2, kind = $3, as_of_date = $4 WHERE id = $1`,
            [feed.id, h.sequence, h.kind, h.asOfDate],
          ),
        );
      }
      if (h && h.programmeCode !== programme.code) {
        // Nothing in a file for another programme belongs to this one, so it does not hold a sequence.
        return this.finish(
          ctx,
          feed,
          started,
          feed.mode === 'live' ? 'rejected' : 'failed',
          `The file is for programme ${h.programmeCode}, not ${programme.code}.`,
          stats,
        );
      }
      // A live feed whose sequence is already applied or taken is rejected, whatever else is wrong with it.
      if (h && feed.mode === 'live') {
        if (programme.status === 'draft' || programme.status === 'closed') {
          return this.finish(
            ctx,
            feed,
            started,
            'rejected',
            `The programme is ${programme.status}; live feeds are not accepted. Send a test feed.`,
            stats,
          );
        }
        if (h.sequence <= programme.last_applied_sequence) {
          return this.finish(
            ctx,
            feed,
            started,
            'rejected',
            `Sequence ${h.sequence} has already been applied (last applied: ${programme.last_applied_sequence}).`,
            stats,
          );
        }
        const clash = await withTx(this.pool, ctx, (tx) =>
          tx.query(
            `SELECT 1 FROM card.feeds WHERE programme_id = $1 AND mode = 'live' AND sequence = $2 AND id <> $3
               AND status IN ('waiting', 'held')`,
            [feed.programme_id, h.sequence, feed.id],
          ),
        );
        if (clash.rowCount) {
          return this.finish(
            ctx,
            feed,
            started,
            'rejected',
            `Another feed with sequence ${h.sequence} is already waiting or held. Reject it first if this file replaces it.`,
            stats,
          );
        }
      }
      if (parsed.fatal.length || !h)
        return this.finish(ctx, feed, started, failed, parsed.fatal.join(' '), stats);
      stats.rejectedRecords += await this.rejectDuplicates(feed);

      if (feed.mode === 'live') {
        if (programme.last_applied_sequence === 0 && h.kind !== 'FULL') {
          return this.finish(
            ctx,
            feed,
            started,
            'held',
            'The first live feed for a programme must be a full feed.',
            stats,
          );
        }
        if (h.sequence !== programme.last_applied_sequence + 1) {
          await withTx(this.pool, ctx, (tx) =>
            tx.query(
              `UPDATE card.feeds SET status = 'waiting', stats = $2, locked_until = NULL,
                      status_reason = $3 WHERE id = $1`,
              [
                feed.id,
                JSON.stringify(stats),
                `Waiting for sequence ${programme.last_applied_sequence + 1}.`,
              ],
            ),
          );
          return {
            status: 'waiting',
            reason: `Waiting for sequence ${programme.last_applied_sequence + 1}.`,
            stats,
          };
        }
      }
    }

    return this.applyOrTest(
      ctx,
      feed,
      programme,
      header as { sequence: number; kind: 'FULL' | 'CHANGE'; asOfDate: string },
      stats,
      started,
      phases,
    );
  }

  /** Streams the file into staging; returns the parse result. Re-running clears earlier staging. */
  private async stage(feed: FeedRow) {
    const ctx = systemContext('eligibility-feeds');
    await withTx(this.pool, ctx, async (tx) => {
      await tx.query(`DELETE FROM card.feed_records WHERE feed_id = $1`, [feed.id]);
      await tx.query(`DELETE FROM card.feed_rejections WHERE feed_id = $1`, [feed.id]);
    });
    let records: FeedRecord[] = [];
    let rejections: RecordRejection[] = [];
    const flushRecords = async () => {
      if (!records.length) return;
      const batch = records;
      records = [];
      await withTx(this.pool, ctx, (tx) =>
        tx.query(
          `INSERT INTO card.feed_records (feed_id, line_no, account_ref, product_code, action, eligible_from, eligible_to)
           SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::char(1)[], $6::date[], $7::date[])`,
          [
            feed.id,
            batch.map((r) => r.lineNo),
            batch.map((r) => r.accountRef),
            batch.map((r) => r.productCode),
            batch.map((r) => r.action),
            batch.map((r) => r.eligibleFrom),
            batch.map((r) => r.eligibleTo),
          ],
        ),
      );
    };
    const flushRejections = async () => {
      if (!rejections.length) return;
      const batch = rejections;
      rejections = [];
      await withTx(this.pool, ctx, (tx) => insertRejections(tx, feed, batch));
    };
    const lines = createInterface({
      input: this.store.read(feed.storage_key),
      crlfDelay: Infinity,
    });
    const result = await parseFeed(lines, {
      record: async (r) => {
        records.push(r);
        if (records.length >= BATCH) await flushRecords();
      },
      reject: async (r) => {
        rejections.push(r);
        if (rejections.length >= BATCH) await flushRejections();
      },
    });
    await flushRecords();
    await flushRejections();
    await withTx(this.pool, ctx, (tx) => tx.query(`ANALYZE card.feed_records`));
    return result;
  }

  /** The first record for an account is used; later ones are rejected. */
  private async rejectDuplicates(feed: FeedRow): Promise<number> {
    const { rows } = await withTx(this.pool, systemContext('eligibility-feeds'), (tx) =>
      tx.query<{ n: string }>(
        `WITH d AS (SELECT line_no, row_number() OVER (PARTITION BY account_ref ORDER BY line_no) AS rn
                      FROM card.feed_records WHERE feed_id = $1),
              del AS (DELETE FROM card.feed_records r USING d
                       WHERE r.feed_id = $1 AND r.line_no = d.line_no AND d.rn > 1
                       RETURNING r.line_no, r.account_ref),
              ins AS (INSERT INTO card.feed_rejections (feed_id, account_id, line_no, account_ref, code, message)
                      SELECT $1, $2, line_no, account_ref, 'duplicate_account',
                             'The account appears more than once in the file; its first record was used.'
                        FROM del RETURNING 1)
         SELECT count(*) AS n FROM ins`,
        [feed.id, feed.account_id],
      ),
    );
    return Number(rows[0]!.n);
  }

  private async applyOrTest(
    ctx: RequestContext,
    feed: FeedRow,
    programme: ProgrammeRow,
    header: { sequence: number; kind: 'FULL' | 'CHANGE'; asOfDate: string },
    baseStats: FeedStats,
    started: number,
    phases: Record<string, number>,
  ): Promise<ProcessOutcome> {
    let mark = Date.now();
    const lap = (name: string) => {
      phases[name] = Date.now() - mark;
      mark = Date.now();
    };
    const client = await this.pool.connect();
    let outcome: ProcessOutcome;
    try {
      // Large feeds outlast the application role's 60-second transaction limit, so this session
      // raises its own limits. The audit record is written last, just before commit (see below).
      await client.query(`SET statement_timeout = 0`);
      await client.query(`SET transaction_timeout = '2h'`);
      await client.query(`SET idle_in_transaction_session_timeout = '5min'`);
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.account_ids', '*', true), set_config('app.actor', $1, true),
                set_config('app.correlation_id', $2, true)`,
        [ctx.principal.subject, ctx.correlationId],
      );
      const locked = await client.query<{ last_applied_sequence: number }>(
        `SELECT last_applied_sequence FROM card.programmes WHERE id = $1 FOR UPDATE`,
        [programme.id],
      );
      // Fresh statistics: right after a large load, autovacuum has not yet seen the new rows, and plans
      // built on stale counts turn a seconds-long change feed into minutes. ANALYZE samples, so it stays
      // well under a second even for tens of millions of rows.
      await client.query(`ANALYZE card.eligibility_periods, card.certificates`);
      if (feed.mode === 'live' && locked.rows[0]!.last_applied_sequence + 1 !== header.sequence) {
        await client.query('ROLLBACK');
        await withTx(this.pool, ctx, (tx) =>
          tx.query(`UPDATE card.feeds SET status = 'waiting', locked_until = NULL WHERE id = $1`, [
            feed.id,
          ]),
        );
        return {
          status: 'waiting',
          reason: 'Waiting for the previous sequence.',
          stats: baseStats,
        };
      }

      const stats = { ...baseStats };
      stats.rejectedRecords += await rejectUnknownAccounts(client, feed, programme.id);
      lap('validate');
      if (
        stats.detailRecords > 0 &&
        (stats.rejectedRecords / stats.detailRecords) * 100 > Number(programme.max_reject_percent)
      ) {
        // Nothing has touched the ledger yet: commit the rejections with the held status.
        const pct = ((stats.rejectedRecords / stats.detailRecords) * 100).toFixed(2);
        outcome = await this.finishIn(
          client,
          ctx,
          feed,
          started,
          feed.mode === 'live' ? 'held' : 'failed',
          `${stats.rejectedRecords} of ${stats.detailRecords} records (${pct}%) were rejected; the limit is ${programme.max_reject_percent}%.`,
          stats,
        );
        await client.query('COMMIT');
        this.afterFinish(feed, outcome);
        return outcome;
      }

      await buildPlan(client, feed, programme.id, header);
      lap('plan');
      const counts = await client.query<{ op: string; n: string }>(
        `SELECT op, count(*) AS n FROM card.feed_plan WHERE feed_id = $1 GROUP BY op`,
        [feed.id],
      );
      for (const c of counts.rows) {
        const n = Number(c.n);
        if (c.op === 'add') stats.added = n;
        if (c.op === 'update') stats.updated = n;
        if (c.op === 'remove') stats.removed = n;
        if (c.op === 'unchanged') stats.unchanged = n;
      }

      if (feed.mode === 'test') {
        // A test feed records its results and never touches the ledger.
        await client.query(`DELETE FROM card.feed_plan WHERE feed_id = $1`, [feed.id]);
        outcome = await this.finishIn(client, ctx, feed, started, 'passed', null, stats);
        await client.query('COMMIT');
        return outcome;
      }

      stats.certificatesIssued = await applyPlan(client, feed, programme, header);
      lap('apply');
      await client.query(
        `UPDATE card.feeds SET status = 'applied', status_reason = NULL, stats = $2, processed_at = now(),
                duration_ms = $3, locked_until = NULL WHERE id = $1`,
        [feed.id, JSON.stringify(stats), Date.now() - started],
      );
      await client.query(
        // Counts for programme lists, recalculated exactly (an index count, once per feed).
        `UPDATE card.programmes SET last_applied_sequence = $2, updated_at = now(),
                accounts_on_file = (SELECT count(*) FROM card.eligibility_periods
                                     WHERE programme_id = $1 AND ended_by IS NULL),
                certificates_issued = certificates_issued + $3
          WHERE id = $1`,
        [programme.id, header.sequence, stats.certificatesIssued],
      );
      await client.query(`DELETE FROM card.feed_records WHERE feed_id = $1`, [feed.id]);
      await client.query(`DELETE FROM card.feed_plan WHERE feed_id = $1`, [feed.id]);
      await publishEvent(
        client,
        ctx,
        EligibilityFeedLoaded,
        eventData(feed, header.sequence, 'applied', null, stats),
        {
          accountId: feed.account_id,
        },
      );
      // Last statement before commit: the audit sealer assumes audit rows commit within seconds.
      await writeAudit(client, ctx, {
        action: 'eligibility_feed.applied',
        resourceType: 'eligibility_feed',
        resourceId: feed.id,
        accountId: feed.account_id,
        data: { programmeId: programme.id, sequence: header.sequence, kind: header.kind, ...stats },
      });
      await client.query('COMMIT');
      lap('finish');
      outcome = { status: 'applied', reason: null, stats, phases };
      this.logger.info(
        { feedId: feed.id, programme: programme.code, ...stats, phases, ms: Date.now() - started },
        'Eligibility feed applied',
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.query('RESET ALL').catch(() => undefined);
      client.release();
    }
    return outcome;
  }

  private async finish(
    ctx: RequestContext,
    feed: FeedRow,
    started: number,
    status: 'held' | 'rejected' | 'passed' | 'failed',
    reason: string | null,
    stats: FeedStats,
  ): Promise<ProcessOutcome> {
    const outcome = await withTx(this.pool, ctx, (tx) =>
      this.finishIn(tx, ctx, feed, started, status, reason, stats),
    );
    this.afterFinish(feed, outcome);
    return outcome;
  }

  private afterFinish(feed: FeedRow, outcome: ProcessOutcome): void {
    if (outcome.status === 'held') {
      this.logger.warn(
        { feedId: feed.id, reason: outcome.reason, alert: 'eligibility_feed_held' },
        'Eligibility feed held',
      );
    }
  }

  /** Records the final status; the audit record is the last statement, so commit straight after. */
  private async finishIn(
    tx: Tx,
    ctx: RequestContext,
    feed: FeedRow,
    started: number,
    status: 'held' | 'rejected' | 'passed' | 'failed',
    reason: string | null,
    stats: FeedStats,
  ): Promise<ProcessOutcome> {
    {
      const seq = await tx.query<{ sequence: number | null }>(
        `UPDATE card.feeds SET status = $2, status_reason = $3, stats = $4, processed_at = now(), duration_ms = $5,
                locked_until = NULL WHERE id = $1 RETURNING sequence`,
        [feed.id, status, reason, JSON.stringify(stats), Date.now() - started],
      );
      // Held and failed feeds keep nothing staged; their files stay in storage for investigation.
      await tx.query(`DELETE FROM card.feed_records WHERE feed_id = $1`, [feed.id]);
      await publishEvent(
        tx,
        ctx,
        EligibilityFeedLoaded,
        eventData(feed, seq.rows[0]?.sequence ?? null, status, reason, stats),
        {
          accountId: feed.account_id,
        },
      );
      await writeAudit(tx, ctx, {
        action: `eligibility_feed.${status}`,
        resourceType: 'eligibility_feed',
        resourceId: feed.id,
        accountId: feed.account_id,
        reason,
        data: { mode: feed.mode, ...stats },
      });
    }
    return { status, reason, stats };
  }
}

function eventData(
  feed: FeedRow,
  sequence: number | null,
  status: string,
  reason: string | null,
  s: FeedStats,
) {
  return {
    feedId: feed.id,
    programmeId: feed.programme_id,
    sequence,
    mode: feed.mode,
    status,
    reason,
    added: s.added,
    updated: s.updated,
    removed: s.removed,
    rejected: s.rejectedRecords,
    certificatesIssued: s.certificatesIssued,
  };
}

async function insertRejections(tx: Tx, feed: FeedRow, batch: RecordRejection[]): Promise<void> {
  await tx.query(
    `INSERT INTO card.feed_rejections (feed_id, account_id, line_no, account_ref, code, message)
     SELECT $1, $2, * FROM unnest($3::int[], $4::text[], $5::text[], $6::text[])`,
    [
      feed.id,
      feed.account_id,
      batch.map((r) => r.lineNo),
      batch.map((r) => r.accountRef),
      batch.map((r) => r.code),
      batch.map((r) => r.message),
    ],
  );
}

/** Updates and removals need the account to be on file at the time the feed is applied. */
async function rejectUnknownAccounts(tx: Tx, feed: FeedRow, programmeId: string): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `WITH del AS (DELETE FROM card.feed_records r
                   WHERE r.feed_id = $1 AND r.action IN ('U', 'D')
                     AND NOT EXISTS (SELECT 1 FROM card.eligibility_periods p
                                      WHERE p.programme_id = $3 AND p.account_ref = r.account_ref AND p.ended_by IS NULL)
                   RETURNING r.line_no, r.account_ref),
          ins AS (INSERT INTO card.feed_rejections (feed_id, account_id, line_no, account_ref, code, message)
                  SELECT $1, $2, line_no, account_ref, 'unknown_account',
                         'The account is not on file for this programme, so it cannot be updated or removed.'
                    FROM del RETURNING 1)
     SELECT count(*) AS n FROM ins`,
    [feed.id, feed.account_id, programmeId],
  );
  return Number(rows[0]!.n);
}

/**
 * Classifies every record against the current ledger:
 * add (not on file), update (product or end date differs), unchanged, remove (D record, or missing from
 * a full feed). Period ends are exclusive internally: valid_to = last eligible day + 1.
 */
async function buildPlan(
  tx: Tx,
  feed: FeedRow,
  programmeId: string,
  header: { kind: 'FULL' | 'CHANGE'; asOfDate: string },
): Promise<void> {
  await tx.query(`DELETE FROM card.feed_plan WHERE feed_id = $1`, [feed.id]);
  await tx.query(
    `INSERT INTO card.feed_plan (feed_id, account_ref, op, product_code, start_from, new_to, period_id, old_from, remove_end)
     SELECT $1, s.account_ref,
            CASE
              WHEN s.action = 'D' THEN 'remove'
              WHEN p.id IS NULL THEN 'add'
              WHEN p.product_code = s.product_code
                   AND p.valid_to IS NOT DISTINCT FROM (s.eligible_to + 1) THEN 'unchanged'
              ELSE 'update'
            END,
            s.product_code,
            -- An account that comes back after removal restarts no earlier than its previous end.
            CASE WHEN p.id IS NULL AND s.action <> 'D'
                 THEN GREATEST(s.eligible_from,
                               coalesce((SELECT max(h.valid_to) FROM card.eligibility_periods h
                                          WHERE h.programme_id = $2 AND h.account_ref = s.account_ref),
                                        s.eligible_from))
                 ELSE s.eligible_from END,
            s.eligible_to + 1,
            p.id, p.valid_from,
            CASE WHEN s.action = 'D' THEN coalesce(s.eligible_to + 1, $3::date) END
       FROM card.feed_records s
       LEFT JOIN card.eligibility_periods p
         ON p.programme_id = $2 AND p.account_ref = s.account_ref AND p.ended_by IS NULL
      WHERE s.feed_id = $1`,
    [feed.id, programmeId, header.asOfDate],
  );
  if (header.kind === 'FULL') {
    await tx.query(
      `INSERT INTO card.feed_plan (feed_id, account_ref, op, period_id, old_from, remove_end)
       SELECT $1, p.account_ref, 'remove', p.id, p.valid_from, $3::date
         FROM card.eligibility_periods p
        WHERE p.programme_id = $2 AND p.ended_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM card.feed_records s WHERE s.feed_id = $1 AND s.account_ref = p.account_ref)`,
      [feed.id, programmeId, header.asOfDate],
    );
  }
  await tx.query(`ANALYZE card.feed_plan`);
}

async function applyPlan(
  tx: Tx,
  feed: FeedRow,
  programme: ProgrammeRow,
  header: { asOfDate: string },
): Promise<number> {
  const D = header.asOfDate;
  // End the periods that are removed or replaced. An end never moves later than it already was.
  await tx.query(
    `UPDATE card.eligibility_periods p
        SET ended_by = $1,
            valid_to = LEAST(coalesce(p.valid_to, 'infinity'::date),
                             GREATEST(CASE WHEN fp.op = 'remove' THEN fp.remove_end ELSE $2::date END, p.valid_from))
       FROM card.feed_plan fp
      WHERE fp.feed_id = $1 AND fp.op IN ('remove', 'update') AND p.id = fp.period_id`,
    [feed.id, D],
  );
  // Replacement periods start at the as-of date; history before it is unchanged.
  await tx.query(
    `INSERT INTO card.eligibility_periods
       (programme_id, account_id, account_ref, product_code, valid_from, valid_to, established_by)
     SELECT $1, $2, account_ref, product_code, nf, new_to, $3
       FROM (SELECT fp.*, GREATEST($4::date, fp.old_from, fp.start_from) AS nf FROM card.feed_plan fp
              WHERE fp.feed_id = $3 AND fp.op = 'update') u
      WHERE new_to IS NULL OR new_to > nf`,
    [programme.id, feed.account_id, feed.id, D],
  );
  // New accounts are eligible from their own eligible-from date.
  await tx.query(
    `INSERT INTO card.eligibility_periods
       (programme_id, account_id, account_ref, product_code, valid_from, valid_to, established_by)
     SELECT $1, $2, account_ref, product_code, start_from, new_to, $3
       FROM card.feed_plan WHERE feed_id = $3 AND op = 'add' AND (new_to IS NULL OR new_to > start_from)`,
    [programme.id, feed.account_id, feed.id],
  );
  const certs = await tx.query<{ n: string }>(
    `WITH ins AS (
       INSERT INTO card.certificates (programme_id, account_ref, account_id, certificate_number, issued_by_feed)
       SELECT $1, fp.account_ref, $2, $3 || '-' || nextval('card.certificate_numbers'), $4
         FROM card.feed_plan fp
        WHERE fp.feed_id = $4 AND fp.op = 'add'
          AND NOT EXISTS (SELECT 1 FROM card.certificates c WHERE c.programme_id = $1 AND c.account_ref = fp.account_ref)
       RETURNING 1)
     SELECT count(*) AS n FROM ins`,
    [programme.id, feed.account_id, programme.code, feed.id],
  );
  return Number(certs.rows[0]!.n);
}
