import nodemailer, { type Transporter } from 'nodemailer';
import { DocumentDeliveryFailed } from '@astra/contracts';
import {
  publishEvent,
  systemContext,
  withTx,
  writeAudit,
  type FileStore,
  type Logger,
  type Pool,
} from '@astra/platform';
import type { WorkerConfig } from './config';
import { Loop } from './loops';

/**
 * Sending issued documents by email (E09-F03-S01). Each queued email delivery is sent with its PDF attached;
 * every attempt is recorded, failures are retried with back-off, and after the last attempt the delivery is
 * marked failed and an event is raised so staff see it in the failed list. Design: docs/adr/0011.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  attachment: { filename: string; content: Buffer };
  /** Sent with the message so the provider can say which delivery its receipt is about. */
  deliveryId?: string;
}

export interface EmailSender {
  /** Sends the message and returns what the server answered (for the attempt record). */
  send(message: EmailMessage): Promise<string>;
}

export class SmtpSender implements EmailSender {
  private readonly transport: Transporter;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(m: EmailMessage): Promise<string> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.deliveryId ? { headers: { 'X-Astra-Delivery-Id': m.deliveryId } } : {}),
      attachments: [
        {
          filename: m.attachment.filename,
          content: m.attachment.content,
          contentType: 'application/pdf',
        },
      ],
    });
    return `accepted by the mail server (${info.messageId})`;
  }
}

/** Used when no mail server is configured: email deliveries then fail with this reason instead of vanishing. */
/** A failure that retrying cannot fix. */
export class PermanentDeliveryError extends Error {}

export class NoMailServer implements EmailSender {
  async send(): Promise<string> {
    throw new PermanentDeliveryError(
      'No mail server is configured (SMTP_URL), so email cannot be sent.',
    );
  }
}

export function senderFor(config: Pick<WorkerConfig, 'SMTP_URL' | 'MAIL_FROM'>): EmailSender {
  return config.SMTP_URL ? new SmtpSender(config.SMTP_URL, config.MAIL_FROM!) : new NoMailServer();
}

/** Wait before the next attempt after the first, second, ... failure. The delivery fails after the last. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

const readAll = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
};

interface Due {
  id: string;
  document_id: string;
  account_id: string;
  recipient: string;
  attempts: number;
  kind: string;
  title: string;
  file_key: string;
  number: string | null;
}

/** Sends the next due email delivery. Returns true when it handled one (so there may be more). */
export async function deliverNext(
  pool: Pool,
  files: FileStore,
  sender: EmailSender,
  logger: Logger,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<boolean> {
  const ctx = systemContext('document-delivery');
  return withTx(pool, ctx, async (tx) => {
    const due = (
      await tx.query<Due>(
        `SELECT x.id, x.document_id, x.account_id, x.recipient, x.attempts, d.kind, d.title, d.file_key, p.number
           FROM documents.deliveries x JOIN documents.documents d ON d.id = x.document_id LEFT JOIN policies.policies p ON p.id = d.policy_id
          WHERE x.channel = 'email' AND x.status = 'queued' AND x.next_attempt_at <= now()
          ORDER BY x.next_attempt_at FOR UPDATE OF x SKIP LOCKED LIMIT 1`,
      )
    ).rows[0];
    if (!due) return false;
    let detail: string;
    let ok = false;
    let permanent = false;
    try {
      const pdf = await readAll(files.read(due.file_key));
      detail = await sender.send({
        to: due.recipient,
        deliveryId: due.id,
        subject: due.number ? `${due.title}, policy ${due.number}` : due.title,
        text: `Your ${due.title.toLowerCase()}${due.number ? ` for policy ${due.number}` : ''} is attached.\n\nKeep it with your travel documents.`,
        attachment: {
          filename: `${(due.number ?? due.kind).replace(/[^A-Za-z0-9._-]/g, '_')}-${due.kind}.pdf`,
          content: pdf,
        },
      });
      ok = true;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
      permanent = err instanceof PermanentDeliveryError;
    }
    const attempts = due.attempts + 1;
    await tx.query(
      `INSERT INTO documents.delivery_attempts (delivery_id, account_id, ok, detail) VALUES ($1, $2, $3, $4)`,
      [due.id, due.account_id, ok, detail.slice(0, 1000)],
    );
    if (ok) {
      await tx.query(
        `UPDATE documents.deliveries SET status = 'sent', attempts = $2, last_error = NULL, next_attempt_at = NULL, delivered_at = now(), updated_at = now() WHERE id = $1`,
        [due.id, attempts],
      );
      logger.info({ deliveryId: due.id, documentId: due.document_id }, 'Document emailed');
    } else if (permanent || attempts > delays.length) {
      await tx.query(
        `UPDATE documents.deliveries SET status = 'failed', attempts = $2, last_error = $3, next_attempt_at = NULL, updated_at = now() WHERE id = $1`,
        [due.id, attempts, detail.slice(0, 1000)],
      );
      await publishEvent(
        tx,
        ctx,
        DocumentDeliveryFailed,
        {
          deliveryId: due.id,
          documentId: due.document_id,
          channel: 'email',
          reason: detail.slice(0, 500),
          attempts,
        },
        { accountId: due.account_id },
      );
      await writeAudit(tx, ctx, {
        action: 'document_delivery.failed',
        resourceType: 'document_delivery',
        resourceId: due.id,
        accountId: due.account_id,
        data: { documentId: due.document_id, attempts, reason: detail.slice(0, 500) },
      });
      logger.warn(
        { deliveryId: due.id, attempts, reason: detail },
        'Document delivery failed for good',
      );
    } else {
      await tx.query(
        `UPDATE documents.deliveries SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval, updated_at = now() WHERE id = $1`,
        [due.id, attempts, detail.slice(0, 1000), String(delays[attempts - 1])],
      );
      logger.warn(
        { deliveryId: due.id, attempts, reason: detail },
        'Document delivery failed; will retry',
      );
    }
    return true;
  });
}

export function documentDeliveryLoop(
  pool: Pool,
  files: FileStore,
  config: WorkerConfig,
  logger: Logger,
): Loop {
  const sender = senderFor(config);
  return new Loop(
    'document-delivery',
    config.WORKER_POLL_MS * 2,
    () => deliverNext(pool, files, sender, logger),
    logger,
  );
}
