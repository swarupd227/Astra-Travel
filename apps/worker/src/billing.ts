import { createHmac } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BillingBatchFailed } from '@astra/contracts';
import { publishEvent, systemContext, withTx, type FileStore, type Logger, type Pool } from '@astra/platform';
import type { WorkerConfig } from './config';
import { Loop } from './loops';

/**
 * Sending premium record batches to Assurant's billing system (E08-F03-S01, E14-F03-S01). The interface is to be
 * agreed (API, files or MuleSoft), so two channels are offered with one batch format: a file drop and a signed
 * HTTP push. Sending is not confirmation: the batch stays `sent` until billing answers on the confirmations
 * endpoint; an unanswered batch is sent again with the same ID, then marked unconfirmed and alerted.
 * Design: docs/adr/0013.
 */

export interface OutgoingBatch {
  id: string;
  number: number;
  fileKey: string;
  sha256: string;
  totals: unknown;
}

export interface BillingChannel {
  kind: 'file' | 'http';
  /** Delivers the batch file; resolves when billing's side has taken it (not when it has confirmed). */
  send(batch: OutgoingBatch, files: FileStore): Promise<void>;
}

export class FileDropChannel implements BillingChannel {
  readonly kind = 'file' as const;
  constructor(private readonly dir: string) {}
  async send(b: OutgoingBatch, files: FileStore): Promise<void> {
    const dir = resolve(this.dir);
    await mkdir(dir, { recursive: true });
    const name = `astra-batch-${String(b.number).padStart(8, '0')}`;
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    // The data file first, then a small control file: billing can treat the control file as "the batch is complete".
    await pipeline(files.read(b.fileKey), createWriteStream(join(dir, `${name}.ndjson.part`)));
    await copyFile(join(dir, `${name}.ndjson.part`), join(dir, `${name}.ndjson`));
    await writeFile(join(dir, `${name}.control.json`), JSON.stringify({ batchId: b.id, number: b.number, sha256: b.sha256, totals: b.totals }, null, 2));
  }
}

export class HttpChannel implements BillingChannel {
  readonly kind = 'http' as const;
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(b: OutgoingBatch, files: FileStore): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of files.read(b.fileKey)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    const body = Buffer.concat(chunks);
    // The signature covers the batch ID and the file's hash, so billing can verify both before it reads a record.
    const signature = createHmac('sha256', this.secret).update(`${b.id}.${b.sha256}`).digest('hex');
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson', 'idempotency-key': b.id, 'x-astra-batch-id': b.id, 'x-astra-batch-number': String(b.number), 'x-astra-sha256': b.sha256, 'x-astra-control-totals': JSON.stringify(b.totals), 'x-astra-signature': signature },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`The billing system answered HTTP ${res.status}`);
  }
}

export function channelFor(config: Pick<WorkerConfig, 'BILLING_DROP_DIR' | 'BILLING_URL' | 'BILLING_SIGNING_SECRET'>): BillingChannel | null {
  if (config.BILLING_URL) return new HttpChannel(config.BILLING_URL, config.BILLING_SIGNING_SECRET!);
  if (config.BILLING_DROP_DIR) return new FileDropChannel(config.BILLING_DROP_DIR);
  return null;
}

export interface SendOptions {
  /** How long to wait for billing's confirmation before sending again. */
  confirmTimeoutMs: number;
  maxAttempts: number;
  /** Wait after a failed send, by attempt. */
  retryDelaysMs: readonly number[];
}

export const SEND_DEFAULTS: SendOptions = { confirmTimeoutMs: 15 * 60_000, maxAttempts: 5, retryDelaysMs: [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] };

/** Sends the next batch that is due (new, or sent and unanswered past its timeout). Returns true when it handled one. */
export async function sendNext(pool: Pool, files: FileStore, channel: BillingChannel | null, logger: Logger, o: SendOptions = SEND_DEFAULTS): Promise<boolean> {
  const ctx = systemContext('billing-sender');
  return withTx(pool, ctx, async (tx) => {
    const b = (
      await tx.query<{ id: string; number: string; status: string; file_key: string; sha256: string; totals: unknown; attempts: number; last_error: string | null }>(
        `SELECT id, number::text, status, file_key, sha256, totals, attempts, last_error FROM billing.batches
          WHERE (status = 'ready' AND (next_attempt_at IS NULL OR next_attempt_at <= now())) OR (status = 'sent' AND next_attempt_at <= now())
          ORDER BY number FOR UPDATE SKIP LOCKED LIMIT 1`,
      )
    ).rows[0];
    if (!b) return false;
    const number = Number(b.number);
    const fail = async (status: 'unconfirmed', reason: string) => {
      await tx.query(`UPDATE billing.batches SET status = $2, last_error = $3, next_attempt_at = NULL WHERE id = $1`, [b.id, status, reason]);
      await publishEvent(tx, ctx, BillingBatchFailed, { batchId: b.id, number, status, reason }, { accountId: null });
      logger.error({ batchId: b.id, number, reason }, 'Billing batch not confirmed');
    };
    if (!channel) {
      const reason = 'No billing channel is configured (set BILLING_DROP_DIR or BILLING_URL), so the batch has not been sent.';
      if (b.last_error !== reason) await tx.query(`UPDATE billing.batches SET last_error = $2 WHERE id = $1`, [b.id, reason]);
      return false;
    }
    if (b.status === 'sent' && b.attempts >= o.maxAttempts) {
      await fail('unconfirmed', `Billing did not confirm the batch after ${b.attempts} sends.`);
      return true;
    }
    const attempts = b.attempts + 1;
    try {
      await channel.send({ id: b.id, number, fileKey: b.file_key, sha256: b.sha256, totals: b.totals }, files);
      await tx.query(`UPDATE billing.batches SET status = 'sent', channel = $2, attempts = $3, sent_at = coalesce(sent_at, now()), last_error = NULL, next_attempt_at = now() + ($4 || ' milliseconds')::interval WHERE id = $1`, [b.id, channel.kind, attempts, String(o.confirmTimeoutMs)]);
      await tx.query(`UPDATE billing.premium_records SET status = 'sent' WHERE batch_id = $1 AND status = 'batched'`, [b.id]);
      logger.info({ batchId: b.id, number, attempts, channel: channel.kind }, 'Billing batch sent');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempts >= o.maxAttempts) await fail('unconfirmed', `Could not send the batch after ${attempts} attempts: ${reason}`);
      else {
        await tx.query(`UPDATE billing.batches SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval WHERE id = $1`, [b.id, attempts, reason.slice(0, 500), String(o.retryDelaysMs[Math.min(attempts - 1, o.retryDelaysMs.length - 1)])]);
        logger.warn({ batchId: b.id, attempts, reason }, 'Billing batch send failed; will retry');
      }
    }
    return true;
  });
}

export function billingSendLoop(pool: Pool, files: FileStore, config: WorkerConfig, logger: Logger): Loop {
  const channel = channelFor(config);
  const options: SendOptions = { ...SEND_DEFAULTS, confirmTimeoutMs: config.BILLING_CONFIRM_TIMEOUT_MS, maxAttempts: config.BILLING_MAX_ATTEMPTS };
  return new Loop('billing-send', config.WORKER_POLL_MS * 5, () => sendNext(pool, files, channel, logger, options), logger);
}
