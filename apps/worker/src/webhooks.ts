import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import type { EventEnvelope } from '@astra/contracts';
import {
  CircuitBreaker,
  checkTargetUrl,
  FLAGS,
  isBlockedAddress,
  outboundFetch,
  signPayload,
  SIGNATURE_HEADER,
  systemContext,
  withTx,
  type DeliveryResult,
  type DynamicSubscriberSource,
  type FeatureFlags,
  type Logger,
  type Pool,
  type SecretBox,
  type TargetPolicy,
  type Tx,
} from '@astra/platform';

export const WEBHOOK_PREFIX = 'webhook:';
export const WEBHOOK_MAX_ATTEMPTS = 12; // about 9 hours of back-off before dead-lettering

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * DNS lookup used for every webhook connection. Rejects private and reserved addresses at connect
 * time, which also defeats DNS rebinding between validation and delivery.
 */
export function guardedLookup(policy: TargetPolicy) {
  return (hostname: string, options: object, callback: LookupCallback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      if (!policy.allowPrivate && list.some((a) => isBlockedAddress(a.address))) {
        const blocked = Object.assign(new Error(`Blocked internal address for ${hostname}`), {
          code: 'EBLOCKED',
        });
        return callback(blocked, []);
      }
      if ((options as { all?: boolean }).all) return callback(null, list);
      const first = list[0];
      if (!first)
        return callback(Object.assign(new Error('No address'), { code: 'ENOTFOUND' }), []);
      return callback(null, first.address, first.family);
    });
  };
}

interface Deps {
  pool: Pool;
  secrets: SecretBox;
  flags: FeatureFlags;
  policy: TargetPolicy;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

interface SubscriptionRow {
  id: string;
  account_id: string;
  url: string;
  status: 'active' | 'paused' | 'disabled';
  secret_ciphertext: string;
  secret_key_id: string;
}

/** Fans events out to each account's active webhook subscriptions and delivers them, signed. */
export function webhookSource(deps: Deps): DynamicSubscriberSource {
  const breaker = new CircuitBreaker(5, 60_000);
  const agent = new Agent({
    connect: { lookup: guardedLookup(deps.policy) as never, timeout: 5_000 },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  const fetchImpl =
    deps.fetchImpl ??
    (((url: string, init: RequestInit) =>
      undiciFetch(url, {
        ...(init as object),
        dispatcher: agent,
      } as never)) as unknown as typeof fetch);

  return {
    prefix: WEBHOOK_PREFIX,

    async subscribersFor(tx: Tx, event: EventEnvelope): Promise<string[]> {
      if (!event.accountId) return [];
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM integration.webhook_subscriptions
          WHERE account_id = $1 AND status = 'active' AND $2 = ANY(event_types)`,
        [event.accountId, event.type],
      );
      return rows.map((r) => `${WEBHOOK_PREFIX}${r.id}`);
    },

    handler: {
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      async handle(event, { subscriber, attempt }): Promise<DeliveryResult> {
        if (!(await deps.flags.isEnabled(FLAGS.webhookDelivery, event.accountId))) {
          return { defer: { delayMs: 60_000, reason: 'webhook delivery is switched off' } };
        }
        const id = subscriber.slice(WEBHOOK_PREFIX.length);
        const ctx = systemContext('webhooks', event.correlationId);
        const sub = await withTx(deps.pool, ctx, async (tx) => {
          const { rows } = await tx.query<SubscriptionRow>(
            `SELECT id, account_id, url, status, secret_ciphertext, secret_key_id
               FROM integration.webhook_subscriptions WHERE id = $1`,
            [id],
          );
          return rows[0];
        });
        if (!sub || sub.status === 'disabled') {
          deps.logger.info(
            { subscriber, eventId: event.id },
            'Webhook subscription removed; delivery skipped',
          );
          return;
        }
        if (sub.status === 'paused') {
          return { defer: { delayMs: 300_000, reason: 'subscription is paused' } };
        }

        checkTargetUrl(sub.url, deps.policy);
        const secret = deps.secrets.open(sub.secret_ciphertext, sub.secret_key_id, sub.id);
        const body = JSON.stringify(event);
        const timestamp = Math.floor(Date.now() / 1000);

        let response: Response;
        try {
          response = await outboundFetch(
            sub.url,
            {
              method: 'POST',
              body,
              redirect: 'manual',
              headers: {
                'content-type': 'application/json',
                'user-agent': 'AstraTravel-Webhooks/1.0',
                'astra-event-id': event.id,
                'astra-event-type': event.type,
                'astra-delivery-attempt': String(attempt),
                'x-correlation-id': event.correlationId,
                [SIGNATURE_HEADER]: signPayload(secret, timestamp, body),
              },
            },
            {
              integration: 'webhook',
              idempotent: false,
              policy: { timeoutMs: 10_000 },
              breaker,
              breakerKey: sub.id,
              fetchImpl,
            },
          );
          await response.body?.cancel().catch(() => undefined);
        } catch (err) {
          await recordResult(deps.pool, ctx, sub.id, false);
          throw err;
        }

        const ok = response.status >= 200 && response.status < 300;
        await recordResult(deps.pool, ctx, sub.id, ok);
        if (!ok) throw new Error(`Endpoint answered HTTP ${response.status}`);
      },
    },
  };
}

async function recordResult(
  pool: Pool,
  ctx: ReturnType<typeof systemContext>,
  id: string,
  ok: boolean,
): Promise<void> {
  await withTx(pool, ctx, (tx) =>
    tx.query(
      `UPDATE integration.webhook_subscriptions
          SET consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures + 1 END
        WHERE id = $1`,
      [id, ok],
    ),
  );
}
