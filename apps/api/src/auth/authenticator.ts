import {
  createRemoteJWKSet,
  decodeJwt,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import {
  defaultGroupForRole,
  isRole,
  isStaffRole,
  isSystemRole,
  permissionsFor,
  ROLES,
  type Role,
} from '@astra/contracts';
import { AppError, type Principal } from '@astra/platform';
import { AGENT_TOKEN_ISSUER, type AgentTokenVerifier } from '@astra/agents/agent-token';
import {
  CHANNEL_TOKEN_ISSUER,
  ChannelTokenError,
  verifyChannelToken,
} from '@astra/contracts/channel-token';
import { ALL_PERMISSIONS, type Permission } from '@astra/contracts';

/**
 * Verifies OpenID Connect access tokens and turns them into principals (E13-F02-S02).
 *
 * - Signature, issuer, audience and expiry are checked against the IdP's published keys.
 * - Roles come from IdP groups (Entra ID group object IDs or names, mapped by configuration) or from
 *   app-role claims. Staff tokens are platform-wide; partner tokens are bound to one account.
 * - Tokens whose total lifetime exceeds the configured maximum are refused, so a user removed from
 *   the IdP loses access within that time even if the IdP is misconfigured.
 */
export interface AuthenticatorOptions {
  issuer: string;
  audience: string;
  maxTokenLifetimeSeconds: number;
  groupRoleMap?: Record<string, Role>;
  /** Injected key set (tests); otherwise discovered from the issuer. */
  keys?: JWTVerifyGetKey;
  /** Verifies run tokens minted by the agent runtime. Agent tokens are refused without it. */
  agentVerifier?: AgentTokenVerifier;
  /** Verifies the short signed tokens sales channels hold (docs/adr/0015). Channel tokens are refused without it. */
  channelSecret?: string;
  /** Kill switch: an agent token is refused as soon as its agent is no longer active. */
  isAgentActive?: (agentId: string) => Promise<boolean>;
}

interface Claims extends JWTPayload {
  groups?: unknown;
  roles?: unknown;
  account_id?: unknown;
  name?: unknown;
  preferred_username?: unknown;
  email?: unknown;
  azp?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseGroupRoleMap(json: string | undefined): Record<string, Role> {
  const map: Record<string, Role> = {};
  for (const role of ROLES) map[defaultGroupForRole(role)] = role;
  if (!json) return map;
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object')
    throw new Error('OIDC_GROUP_ROLE_MAP must be a JSON object');
  for (const [group, role] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof role !== 'string' || !isRole(role)) {
      throw new Error(`OIDC_GROUP_ROLE_MAP maps ${group} to unknown role ${String(role)}`);
    }
    map[group] = role;
  }
  return map;
}

export class Authenticator {
  private keys: JWTVerifyGetKey | undefined;
  private discovering: Promise<JWTVerifyGetKey> | undefined;
  private readonly groupRoleMap: Record<string, Role>;

  constructor(private readonly opts: AuthenticatorOptions) {
    this.keys = opts.keys;
    this.groupRoleMap = opts.groupRoleMap ?? parseGroupRoleMap(undefined);
  }

  async authenticate(authorization: string | undefined): Promise<Principal> {
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization ?? '');
    if (!match?.[1])
      throw new AppError('unauthenticated', 'Send an OAuth 2.0 bearer access token.');

    if (this.issuerOf(match[1]) === AGENT_TOKEN_ISSUER) return this.authenticateAgent(match[1]);
    if (this.issuerOf(match[1]) === CHANNEL_TOKEN_ISSUER) return this.authenticateChannel(match[1]);

    let payload: Claims;
    try {
      const result = await jwtVerify(match[1], await this.keySet(), {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        algorithms: ['RS256', 'PS256', 'ES256'],
        clockTolerance: 30,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      payload = result.payload as Claims;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new AppError('unauthenticated', 'The access token has expired.');
      }
      if (err instanceof AppError) throw err;
      throw new AppError('unauthenticated', 'The access token is not valid.');
    }

    if (payload.exp! - payload.iat! > this.opts.maxTokenLifetimeSeconds) {
      throw new AppError(
        'unauthenticated',
        `Access tokens may live at most ${this.opts.maxTokenLifetimeSeconds} seconds.`,
      );
    }
    return this.toPrincipal(payload);
  }

  private issuerOf(token: string): string | undefined {
    try {
      return decodeJwt(token).iss;
    } catch {
      return undefined;
    }
  }

  /** Channel principals: one account, the permissions their scope allows, and for a browser one quote. */
  private authenticateChannel(token: string): Principal {
    if (!this.opts.channelSecret)
      throw new AppError('unauthenticated', 'Channel tokens are not accepted here.');
    let claims;
    try {
      claims = verifyChannelToken(this.opts.channelSecret, token);
    } catch (err) {
      throw new AppError(
        'unauthenticated',
        err instanceof ChannelTokenError ? err.message : 'The channel token is not valid.',
      );
    }
    if (!UUID.test(claims.accountId))
      throw new AppError('unauthenticated', 'The channel token is not valid.');
    const known = new Set<string>(ALL_PERMISSIONS);
    return {
      kind: 'partner',
      subject: `channel:${claims.scope}:${claims.sub}`,
      name: `${claims.scope} channel`,
      email: null,
      roles: [],
      permissions: claims.permissions.filter((p): p is Permission => known.has(p)),
      accountScope: { type: 'accounts', accountIds: [claims.accountId.toLowerCase()] },
      ...(claims.quoteId ? { quoteId: claims.quoteId } : {}),
    };
  }

  /**
   * Agent principals (E15-F02-S01): permissions and account scope come only from the run token, which
   * the runtime limits to warrant, registered data access and the requesting person's own access.
   */
  private async authenticateAgent(token: string): Promise<Principal> {
    if (!this.opts.agentVerifier)
      throw new AppError('unauthenticated', 'Agent tokens are not accepted here.');
    let claims;
    try {
      claims = await this.opts.agentVerifier.verify(token);
    } catch {
      throw new AppError('unauthenticated', 'The agent token is not valid.');
    }
    if (this.opts.isAgentActive && !(await this.opts.isAgentActive(claims.agentId))) {
      throw new AppError('forbidden', `Agent ${claims.agentId} is paused.`);
    }
    const known = new Set<string>(ALL_PERMISSIONS);
    return {
      kind: 'agent',
      subject: `agent:${claims.agentId}`,
      name: `${claims.agentName} for ${claims.onBehalfOfName ?? claims.onBehalfOf}`,
      email: null,
      roles: [],
      permissions: claims.permissions.filter((p): p is Permission => known.has(p)),
      accountScope:
        claims.accountScope === '*'
          ? { type: 'all' }
          : { type: 'accounts', accountIds: claims.accountScope },
    };
  }

  rolesFromClaims(payload: Claims): Role[] {
    const roles = new Set<Role>();
    const groups = Array.isArray(payload.groups) ? payload.groups : [];
    for (const g of groups) {
      if (typeof g !== 'string') continue;
      const role = this.groupRoleMap[g] ?? this.groupRoleMap[g.replace(/^\//, '')];
      if (role) roles.add(role);
    }
    const appRoles = Array.isArray(payload.roles) ? payload.roles : [];
    for (const r of appRoles) if (typeof r === 'string' && isRole(r)) roles.add(r);
    return ROLES.filter((r) => roles.has(r));
  }

  private toPrincipal(payload: Claims): Principal {
    const roles = this.rolesFromClaims(payload);
    const isPartner = roles.includes('partner_developer');
    const name =
      typeof payload.name === 'string'
        ? payload.name
        : typeof payload.preferred_username === 'string'
          ? payload.preferred_username
          : null;
    const email = typeof payload.email === 'string' ? payload.email : null;

    if (isPartner) {
      if (roles.some((r) => isStaffRole(r))) {
        throw new AppError('forbidden', 'A token cannot carry both partner and staff roles.');
      }
      const accountId = payload.account_id;
      if (typeof accountId !== 'string' || !UUID.test(accountId)) {
        throw new AppError('forbidden', 'Partner tokens must carry an account_id claim.');
      }
      return {
        kind: 'partner',
        subject: payload.sub!,
        name: typeof payload.azp === 'string' ? payload.azp : name,
        email,
        roles,
        permissions: permissionsFor(roles),
        accountScope: { type: 'accounts', accountIds: [accountId.toLowerCase()] },
      };
    }

    if (roles.length === 0) {
      throw new AppError(
        'forbidden',
        'Your account has no Astra Travel role. Ask an administrator.',
      );
    }
    // Assurant systems (for example the claims application) hold only system roles.
    const systemRoles = roles.filter((r) => isSystemRole(r));
    if (systemRoles.length && systemRoles.length !== roles.length) {
      throw new AppError('forbidden', 'A token cannot carry both system and person roles.');
    }
    return {
      kind: systemRoles.length ? 'system' : 'user',
      subject: payload.sub!,
      name: systemRoles.length && typeof payload.azp === 'string' ? payload.azp : name,
      email,
      roles,
      permissions: permissionsFor(roles),
      accountScope: { type: 'all' },
    };
  }

  private async keySet(): Promise<JWTVerifyGetKey> {
    if (this.keys) return this.keys;
    this.discovering ??= (async () => {
      const res = await fetch(
        `${this.opts.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
        {
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) throw new Error(`OIDC discovery failed with HTTP ${res.status}`);
      const doc = (await res.json()) as { jwks_uri?: string; issuer?: string };
      if (!doc.jwks_uri) throw new Error('OIDC discovery document has no jwks_uri');
      if (doc.issuer !== this.opts.issuer) {
        throw new Error(`OIDC issuer mismatch: expected ${this.opts.issuer}, got ${doc.issuer}`);
      }
      return createRemoteJWKSet(new URL(doc.jwks_uri), {
        cooldownDuration: 30_000,
        timeoutDuration: 5_000,
      });
    })().catch((err: unknown) => {
      this.discovering = undefined;
      throw new AppError(
        'service_unavailable',
        `Identity provider unavailable: ${(err as Error).message}`,
      );
    });
    this.keys = await this.discovering;
    return this.keys;
  }
}
