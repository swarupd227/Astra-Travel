import { describe, expect, it } from 'vitest';
import { KeycloakIssuer } from './credentials';

/** The Keycloak admin calls, checked against a fake server. The values are SYNTHETIC. */
function server() {
  const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  let createStatus = 201;
  let found: { id: string }[] = [{ id: 'kc-internal-id' }];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(String(init.body)) : null;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? 'GET', body, auth: headers.authorization ?? null });
    if (url.endsWith('/protocol/openid-connect/token')) return new Response(JSON.stringify({ access_token: 'admin-token' }), { status: 200 });
    if ((init.method ?? 'GET') === 'POST') return new Response('', { status: createStatus });
    if ((init.method ?? 'GET') === 'GET') return new Response(JSON.stringify(found), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, setCreate: (s: number) => (createStatus = s), setFound: (f: { id: string }[]) => (found = f) };
}
const options = (fetchImpl: typeof fetch) => ({ url: 'https://idp.example.test', realm: 'astra', adminClientId: 'astra-admin', adminClientSecret: 'admin-secret', audience: 'astra-api', partnerGroup: 'astra-partner-developer', fetchImpl });

describe('KeycloakIssuer (E07-F03-S02)', () => {
  it('creates a confidential client carrying the account claim, the audience and the partner group, and returns its secret once', async () => {
    const s = server();
    const out = await new KeycloakIssuer(options(s.fetchImpl)).issue({ id: '11111111-2222-4333-8444-555555555555', code: 'ACME-SBX' });
    expect(out.clientId).toMatch(/^astra-sbx-acme-sbx-[0-9a-f]{6}$/);
    expect(out.clientSecret.length).toBeGreaterThanOrEqual(40);
    expect(out.tokenUrl).toBe('https://idp.example.test/realms/astra/protocol/openid-connect/token');
    // It signs in with the admin client first, then creates the client with that token.
    expect(s.calls[0]!.body).toMatchObject({ grant_type: 'client_credentials', client_id: 'astra-admin', client_secret: 'admin-secret' });
    const create = s.calls[1]!;
    expect(create).toMatchObject({ method: 'POST', url: 'https://idp.example.test/admin/realms/astra/clients', auth: 'Bearer admin-token' });
    const body = create.body as { clientId: string; secret: string; serviceAccountsEnabled: boolean; standardFlowEnabled: boolean; protocolMappers: { name: string; config: Record<string, string> }[] };
    expect(body).toMatchObject({ clientId: out.clientId, secret: out.clientSecret, serviceAccountsEnabled: true, standardFlowEnabled: false });
    const mapper = (n: string) => body.protocolMappers.find((m) => m.name === n)!.config;
    expect(mapper('account')).toMatchObject({ 'claim.name': 'account_id', 'claim.value': '11111111-2222-4333-8444-555555555555' });
    expect(mapper('partner-group')).toMatchObject({ 'claim.name': 'groups', 'claim.value': '["astra-partner-developer"]' });
    expect(mapper('audience')).toMatchObject({ 'included.custom.audience': 'astra-api' });
  });

  it('says plainly when the identity provider refuses', async () => {
    const s = server();
    s.setCreate(409);
    await expect(new KeycloakIssuer(options(s.fetchImpl)).issue({ id: 'a', code: 'X' })).rejects.toThrow('did not create the client (HTTP 409)');
    const bad = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(new KeycloakIssuer(options(bad)).issue({ id: 'a', code: 'X' })).rejects.toThrow('refused the admin credentials');
  });

  it('revokes by looking the client up and deleting it', async () => {
    const s = server();
    await new KeycloakIssuer(options(s.fetchImpl)).revoke('astra-sbx-acme-1');
    expect(s.calls.map((c) => `${c.method} ${c.url.replace('https://idp.example.test', '')}`)).toEqual([
      'POST /realms/astra/protocol/openid-connect/token',
      'GET /admin/realms/astra/clients?clientId=astra-sbx-acme-1',
      'DELETE /admin/realms/astra/clients/kc-internal-id',
    ]);
    const none = server();
    none.setFound([]);
    await new KeycloakIssuer(options(none.fetchImpl)).revoke('gone');
    expect(none.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
