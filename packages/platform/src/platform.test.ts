import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './canonical-json';
import { accountScopeSetting, normaliseCorrelationId } from './context';
import { deliveryBackoffMs } from './events/dispatcher';
import { checkTargetUrl, isBlockedAddress, UnsafeTargetError } from './net-guard';
import {
  backoffDelay,
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_RETRY_POLICY,
  outboundFetch,
} from './outbound';
import { SecretBox } from './secrets';
import { signPayload, verifySignature } from './webhook-signing';

describe('canonicalJson', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
  });
});

describe('tenancy setting', () => {
  it('maps scopes to the row-level security setting', () => {
    expect(accountScopeSetting({ type: 'all' })).toBe('*');
    expect(accountScopeSetting({ type: 'accounts', accountIds: ['a', 'b'] })).toBe('a,b');
    expect(accountScopeSetting({ type: 'accounts', accountIds: [] })).toBe('');
  });

  it('accepts only safe correlation IDs', () => {
    expect(normaliseCorrelationId('order-42.x:y')).toBe('order-42.x:y');
    expect(normaliseCorrelationId('bad id\nwith newline')).toMatch(/^[0-9a-f-]{36}$/);
    expect(normaliseCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('SecretBox', () => {
  const key = randomBytes(32).toString('base64');
  const box = new SecretBox({ k1: key }, 'k1');

  it('round-trips and binds ciphertext to its record', () => {
    const sealed = box.seal('whsec_abc', 'record-1');
    expect(sealed.ciphertext).not.toContain('whsec');
    expect(box.open(sealed.ciphertext, 'k1', 'record-1')).toBe('whsec_abc');
    expect(() => box.open(sealed.ciphertext, 'k1', 'record-2')).toThrow();
  });

  it('detects tampering and supports key rotation', () => {
    const sealed = box.seal('secret', 'r');
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[bytes.length - 1]! ^= 1;
    expect(() => box.open(bytes.toString('base64'), 'k1', 'r')).toThrow();
    const rotated = new SecretBox({ k1: key, k2: randomBytes(32).toString('base64') }, 'k2');
    expect(rotated.open(sealed.ciphertext, 'k1', 'r')).toBe('secret');
    expect(rotated.seal('x', 'r').keyId).toBe('k2');
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"id":"1"}';

  it('verifies a valid signature within tolerance', () => {
    const header = signPayload(secret, 1_700_000_000, body);
    expect(verifySignature(secret, header, body, 1_700_000_100)).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets and replays outside tolerance', () => {
    const header = signPayload(secret, 1_700_000_000, body);
    expect(verifySignature(secret, header, '{"id":"2"}', 1_700_000_000)).toBe(false);
    expect(verifySignature('other', header, body, 1_700_000_000)).toBe(false);
    expect(verifySignature(secret, header, body, 1_700_000_301)).toBe(false);
    expect(verifySignature(secret, 'garbage', body, 1_700_000_000)).toBe(false);
  });
});

describe('net guard', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.3.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fd00::1',
    '::ffff:10.0.0.1',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it('allows public addresses', () => {
    expect(isBlockedAddress('203.0.113.10')).toBe(false);
    expect(isBlockedAddress('2606:4700::1111')).toBe(false);
  });

  it('requires https and public hosts unless private targets are allowed', () => {
    expect(() => checkTargetUrl('http://partner.example/hook', { allowPrivate: false })).toThrow(
      UnsafeTargetError,
    );
    expect(() => checkTargetUrl('https://localhost/hook', { allowPrivate: false })).toThrow(
      UnsafeTargetError,
    );
    expect(() => checkTargetUrl('https://10.0.0.1/hook', { allowPrivate: false })).toThrow(
      UnsafeTargetError,
    );
    expect(checkTargetUrl('https://partner.example/hook', { allowPrivate: false }).hostname).toBe(
      'partner.example',
    );
    expect(checkTargetUrl('http://localhost:9000/hook', { allowPrivate: true }).port).toBe('9000');
    expect(() => checkTargetUrl('ftp://x/y', { allowPrivate: true })).toThrow(UnsafeTargetError);
  });
});

describe('retry and back-off', () => {
  it('backs off exponentially with jitter and caps the delay', () => {
    const p = DEFAULT_RETRY_POLICY;
    expect(backoffDelay(1, p, () => 0)).toBe(100);
    expect(backoffDelay(1, p, () => 1)).toBe(200);
    expect(backoffDelay(3, p, () => 1)).toBe(800);
    expect(backoffDelay(30, p, () => 1)).toBe(p.maxDelayMs);
    expect(deliveryBackoffMs(1, () => 0.5)).toBe(10_000);
    expect(deliveryBackoffMs(20, () => 0.5)).toBe(3_600_000);
  });

  const respond = (...statuses: number[]) => {
    const fn = vi.fn(async () => new Response('x', { status: statuses.shift() ?? 200 }));
    return fn as unknown as typeof fetch & typeof fn;
  };

  it('retries idempotent calls on retryable statuses', async () => {
    const fetchImpl = respond(503, 502, 200);
    const res = await outboundFetch(
      'https://svc.example/x',
      { method: 'GET' },
      { integration: 't', idempotent: true, fetchImpl, sleep: async () => undefined },
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never retries non-idempotent calls or client errors', async () => {
    const post = respond(503, 200);
    expect(
      (
        await outboundFetch(
          'https://svc.example/x',
          { method: 'POST' },
          { integration: 't', idempotent: false, fetchImpl: post, sleep: async () => undefined },
        )
      ).status,
    ).toBe(503);
    expect(post).toHaveBeenCalledTimes(1);
    const bad = respond(400, 200);
    expect(
      (
        await outboundFetch(
          'https://svc.example/x',
          {},
          { integration: 't', idempotent: true, fetchImpl: bad, sleep: async () => undefined },
        )
      ).status,
    ).toBe(400);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit after repeated failures and half-opens after the cool-down', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1_000, () => now);
    const fetchImpl = respond(500, 500, 200, 200);
    const opts = {
      integration: 't',
      idempotent: false,
      breaker,
      breakerKey: 'svc',
      fetchImpl,
      sleep: async () => undefined,
    };
    await outboundFetch('https://svc.example/x', {}, opts);
    await outboundFetch('https://svc.example/x', {}, opts);
    await expect(outboundFetch('https://svc.example/x', {}, opts)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    now = 1_500;
    expect((await outboundFetch('https://svc.example/x', {}, opts)).status).toBe(200);
    expect(breaker.isOpen('svc')).toBe(false);
  });
});
