import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Channel tokens (Increment 14, docs/adr/0015): short signed tokens that carry exactly what a sales channel may
 * do for one account. HMAC-SHA256 over a JWT-shaped payload, so they are inspectable and the API can tell them
 * from identity-provider tokens by their issuer. Server-side only: it uses node:crypto.
 */

export const CHANNEL_TOKEN_ISSUER = 'astra-channel';
export const CHANNEL_SCOPES = ['widget', 'journey'] as const;
export type ChannelScope = (typeof CHANNEL_SCOPES)[number];

/** The permissions each scope may carry, whatever a token asks for: a browser-held token can never bind. */
export const CHANNEL_SCOPE_PERMISSIONS: Record<ChannelScope, readonly string[]> = {
  widget: ['quotes:read', 'quotes:reselect'],
  journey: ['quotes:create', 'quotes:read', 'quotes:reselect', 'policies:read', 'documents:read'],
};

export interface ChannelClaims {
  scope: ChannelScope;
  accountId: string;
  /** Who or what the token was made for, for the audit trail (a journey slug, a quote ID). */
  sub: string;
  permissions: string[];
  /** A browser-held token is limited to one quote. */
  quoteId?: string;
  iat: number;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (input: string, secret: string) => createHmac('sha256', secret).update(input).digest();

export function signChannelToken(secret: string, claims: Omit<ChannelClaims, 'iat' | 'exp'>, lifetimeSeconds: number, now: Date = new Date()): { token: string; expiresAt: Date } {
  if (secret.length < 32) throw new Error('The channel signing secret must be at least 32 characters.');
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + lifetimeSeconds;
  // A token carries only what its scope allows.
  const permissions = claims.permissions.filter((p) => CHANNEL_SCOPE_PERMISSIONS[claims.scope].includes(p));
  const payload = { iss: CHANNEL_TOKEN_ISSUER, ...claims, permissions, iat, exp };
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  return { token: `${head}.${body}.${b64(sign(`${head}.${body}`, secret))}`, expiresAt: new Date(exp * 1000) };
}

export class ChannelTokenError extends Error {}

export function verifyChannelToken(secret: string, token: string, now: Date = new Date()): ChannelClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new ChannelTokenError('The channel token is malformed.');
  const [head, body, sig] = parts as [string, string, string];
  const expected = sign(`${head}.${body}`, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ChannelTokenError('The channel token is not valid.');
  let payload: Partial<ChannelClaims> & { iss?: string };
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') throw new ChannelTokenError('The channel token is not valid.');
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof payload;
  } catch (err) {
    if (err instanceof ChannelTokenError) throw err;
    throw new ChannelTokenError('The channel token is malformed.');
  }
  if (
    payload.iss !== CHANNEL_TOKEN_ISSUER ||
    !payload.scope ||
    !(CHANNEL_SCOPES as readonly string[]).includes(payload.scope) ||
    typeof payload.accountId !== 'string' ||
    typeof payload.sub !== 'string' ||
    !Array.isArray(payload.permissions) ||
    typeof payload.exp !== 'number' ||
    typeof payload.iat !== 'number'
  ) {
    throw new ChannelTokenError('The channel token is not valid.');
  }
  if (payload.exp * 1000 < now.getTime()) throw new ChannelTokenError('The channel token has expired.');
  const allowed = CHANNEL_SCOPE_PERMISSIONS[payload.scope];
  return {
    scope: payload.scope,
    accountId: payload.accountId,
    sub: payload.sub,
    permissions: payload.permissions.filter((p): p is string => typeof p === 'string' && allowed.includes(p)),
    ...(payload.quoteId ? { quoteId: payload.quoteId } : {}),
    iat: payload.iat,
    exp: payload.exp,
  };
}
