/** E13-F02-S02 (SSO, roles from IdP groups) and E11-F01-S02 (permissions tested for each role). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, STAFF_ROLES, type Permission } from '@astra/contracts';
import { bearer, createTestApp, insertAccount, resetDatabase, type TestContext } from './helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => resetDatabase());

describe('authentication', () => {
  it('requires a bearer token and answers with a problem document', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(res.json().correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('propagates a caller correlation ID', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-correlation-id': 'booking-123.abc' },
    });
    expect(res.headers['x-correlation-id']).toBe('booking-123.abc');
  });

  it('rejects tokens for another audience or issuer', async () => {
    for (const token of [
      await t.idp.token({ roles: ['platform_admin'], audience: 'other-api' }),
      await t.idp.token({ roles: ['platform_admin'], issuer: 'https://evil.example' }),
    ]) {
      const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects tokens that live longer than 15 minutes, so removed users lose access in time', async () => {
    const token = await t.idp.token({ roles: ['platform_admin'], lifetimeSeconds: 3600 });
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/at most 900 seconds/);
  });

  it('refuses users with no Astra role', async () => {
    const token = await t.idp.token({ groups: ['some-other-group'] });
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(res.statusCode).toBe(403);
  });

  it('refuses partner tokens without an account and tokens mixing partner and staff roles', async () => {
    const noAccount = await t.idp.token({ roles: ['partner_developer'] });
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(noAccount) })).statusCode,
    ).toBe(403);
    const mixed = await t.idp.token({
      roles: ['partner_developer', 'platform_admin'],
      accountId: '7d1f6c2a-3b4e-4f5a-8b6c-9d0e1f2a3b01',
    });
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(mixed) })).statusCode,
    ).toBe(403);
  });

  it('maps IdP groups to roles and permissions', async () => {
    const token = await t.idp.token({ roles: ['compliance_officer', 'ops_supervisor'] });
    const me = (
      await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })
    ).json();
    expect(me.roles).toEqual(['compliance_officer', 'ops_supervisor']);
    expect(me.permissions).toContain('audit:verify');
    expect(me.permissions).toContain('events:replay');
    expect(me.accountScope).toEqual({ type: 'all' });
  });

  it('suspends a partner when its API access flag is turned off', async () => {
    const accountId = await insertAccount(t.pool, 'FLAGGED');
    const token = await t.idp.token({ roles: ['partner_developer'], accountId });
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })).statusCode,
    ).toBe(200);
    const admin = await t.idp.token({ roles: ['platform_admin'] });
    const set = await t.app.inject({
      method: 'POST',
      url: '/v1/feature-flags/api.partner-access/overrides',
      headers: bearer(admin),
      payload: { accountId, enabled: false, reason: 'Suspicious traffic' },
    });
    expect(set.statusCode, set.body).toBe(200);
    const blocked = await t.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().detail).toMatch(/suspended/);
  });
});

describe('permissions for each role', () => {
  const READS: { permission: Permission; url: string }[] = [
    { permission: 'accounts:read', url: '/v1/accounts' },
    { permission: 'webhooks:read', url: '/v1/webhook-subscriptions' },
    { permission: 'events:read', url: '/v1/events' },
    { permission: 'events:read', url: '/v1/event-deliveries' },
    { permission: 'audit:read', url: '/v1/audit' },
    { permission: 'flags:read', url: '/v1/feature-flags' },
  ];

  for (const role of STAFF_ROLES) {
    it(`${role} can call exactly the endpoints its permissions allow`, async () => {
      const token = await t.idp.token({ roles: [role] });
      for (const r of READS) {
        const res = await t.app.inject({ method: 'GET', url: r.url, headers: bearer(token) });
        const allowed = ROLE_PERMISSIONS[role].includes(r.permission);
        expect(res.statusCode, `${role} GET ${r.url}`).toBe(allowed ? 200 : 403);
      }
      const create = await t.app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { ...bearer(token), 'idempotency-key': `perm-${role}-${Date.now()}` },
        payload: {
          code: `P-${role.slice(0, 20).toUpperCase().replace(/_/g, '-')}`,
          name: 'Permission test',
          kind: 'bank',
        },
      });
      expect(create.statusCode, `${role} POST /v1/accounts`).toBe(
        ROLE_PERMISSIONS[role].includes('accounts:manage') ? 201 : 403,
      );
    });
  }
});
