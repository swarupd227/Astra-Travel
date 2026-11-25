import { describe, expect, it } from 'vitest';
import { ChannelTokenError, signChannelToken, verifyChannelToken } from './channel-token';

const SECRET = 'a-test-channel-signing-secret-0123456789';
const account = '11111111-2222-4333-8444-555555555555';

describe('channel tokens (docs/adr/0015)', () => {
  it('round-trip what they carry, limited to the scope', () => {
    const { token, expiresAt } = signChannelToken(SECRET, { scope: 'widget', accountId: account, sub: 'quote-1', permissions: ['quotes:read', 'quotes:reselect', 'quotes:create'], quoteId: 'q1' }, 600);
    const c = verifyChannelToken(SECRET, token);
    // A browser-held token can never carry the permission to create or bind, whatever it was asked for.
    expect(c).toMatchObject({ scope: 'widget', accountId: account, quoteId: 'q1', permissions: ['quotes:read', 'quotes:reselect'] });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
  it('lets a journey token create and bind', () => {
    const { token } = signChannelToken(SECRET, { scope: 'journey', accountId: account, sub: 'acme', permissions: ['quotes:create', 'documents:read', 'accounts:manage'] }, 600);
    expect(verifyChannelToken(SECRET, token).permissions).toEqual(['quotes:create', 'documents:read']);
  });
  it('refuses a changed payload, a wrong secret, an expired token and nonsense', () => {
    const now = new Date('2026-11-26T10:00:00Z');
    const { token } = signChannelToken(SECRET, { scope: 'journey', accountId: account, sub: 'acme', permissions: [] }, 600, now);
    const [h, , s] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ iss: 'astra-channel', scope: 'journey', accountId: 'other', sub: 'x', permissions: ['quotes:create'], iat: 1, exp: 9999999999 })).toString('base64url');
    expect(() => verifyChannelToken(SECRET, `${h}.${forgedBody}.${s}`, now)).toThrow(ChannelTokenError);
    expect(() => verifyChannelToken('another-secret-another-secret-123456', token, now)).toThrow(ChannelTokenError);
    expect(() => verifyChannelToken(SECRET, token, new Date('2026-11-26T10:11:00Z'))).toThrow('expired');
    expect(() => verifyChannelToken(SECRET, 'not.a.token', now)).toThrow(ChannelTokenError);
    expect(() => verifyChannelToken(SECRET, 'x', now)).toThrow('malformed');
  });
  it('will not sign with a short secret', () => {
    expect(() => signChannelToken('short', { scope: 'widget', accountId: account, sub: 'x', permissions: [] }, 60)).toThrow('at least 32');
  });
});
