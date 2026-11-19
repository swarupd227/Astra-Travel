import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures. Header format: `Astra-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`
 * where the HMAC covers `<t>.<raw body>`. Receivers reject signatures older than the tolerance to
 * stop replays. This is the documented contract for account and Service Cloud consumers.
 */
export const SIGNATURE_HEADER = 'Astra-Signature';

export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}
