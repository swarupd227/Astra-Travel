import { randomBytes } from 'node:crypto';

/**
 * Issuing sandbox credentials (E07-F03-S02). The platform never holds a secret: it asks the identity provider to
 * create a confidential client carrying the sandbox account's claim, and hands the secret to the person once.
 * Design: docs/adr/0014.
 */

export interface IssuedCredentials {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export interface CredentialIssuer {
  issue(account: { id: string; code: string }): Promise<IssuedCredentials>;
  revoke(clientId: string): Promise<void>;
}

export interface KeycloakIssuerOptions {
  /** Base URL of Keycloak, for example http://localhost:8080 */
  url: string;
  realm: string;
  /** A service-account client allowed to manage clients in the realm. */
  adminClientId: string;
  adminClientSecret: string;
  /** The audience the platform API expects, and the group that maps to the partner role. */
  audience: string;
  partnerGroup: string;
  fetchImpl?: typeof fetch;
}

export class KeycloakIssuer implements CredentialIssuer {
  private readonly f: typeof fetch;
  constructor(private readonly o: KeycloakIssuerOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  private get tokenUrl() {
    return `${this.o.url}/realms/${this.o.realm}/protocol/openid-connect/token`;
  }

  private async adminToken(): Promise<string> {
    const res = await this.f(this.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.o.adminClientId, client_secret: this.o.adminClientSecret }) });
    if (!res.ok) throw new Error(`The identity provider refused the admin credentials (HTTP ${res.status}).`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async issue(account: { id: string; code: string }): Promise<IssuedCredentials> {
    const token = await this.adminToken();
    const clientId = `astra-sbx-${account.code.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${randomBytes(3).toString('hex')}`;
    const clientSecret = randomBytes(32).toString('base64url');
    const mapper = (name: string, claim: string, value: string, json = 'String') => ({ name, protocol: 'openid-connect', protocolMapper: 'oidc-hardcoded-claim-mapper', config: { 'claim.name': claim, 'claim.value': value, 'jsonType.label': json, 'access.token.claim': 'true', 'id.token.claim': 'false', 'introspection.token.claim': 'true' } });
    const res = await this.f(`${this.o.url}/admin/realms/${this.o.realm}/clients`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId,
        name: `Sandbox credentials for ${account.code}`,
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        clientAuthenticatorType: 'client-secret',
        secret: clientSecret,
        standardFlowEnabled: false,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: true,
        attributes: { 'access.token.lifespan': '300' },
        protocolMappers: [
          { name: 'audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.custom.audience': this.o.audience, 'access.token.claim': 'true', 'id.token.claim': 'false', 'introspection.token.claim': 'true' } },
          mapper('account', 'account_id', account.id),
          mapper('partner-group', 'groups', JSON.stringify([this.o.partnerGroup]), 'JSON'),
        ],
      }),
    });
    if (res.status !== 201) throw new Error(`The identity provider did not create the client (HTTP ${res.status}).`);
    return { clientId, clientSecret, tokenUrl: this.tokenUrl };
  }

  async revoke(clientId: string): Promise<void> {
    const token = await this.adminToken();
    const find = await this.f(`${this.o.url}/admin/realms/${this.o.realm}/clients?clientId=${encodeURIComponent(clientId)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!find.ok) throw new Error(`The identity provider could not look up the client (HTTP ${find.status}).`);
    const found = (await find.json()) as { id: string }[];
    if (!found[0]) return;
    const del = await this.f(`${this.o.url}/admin/realms/${this.o.realm}/clients/${found[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    if (!del.ok && del.status !== 404) throw new Error(`The identity provider did not remove the client (HTTP ${del.status}).`);
  }
}
