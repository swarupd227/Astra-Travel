import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from 'jose';

/**
 * Short-lived identity for one agent run. The runtime signs it (Ed25519); the API verifies it like any
 * other access token and turns it into an `agent` principal with exactly these permissions and account
 * scope (E15-F02-S01).
 */
export const AGENT_TOKEN_ISSUER = 'astra-agent-runtime';
export const AGENT_TOKEN_TTL_SECONDS = 600;

export interface AgentTokenClaims {
  agentId: string;
  agentName: string;
  runId: string;
  /** Subject and display name of the person the agent acts for. */
  onBehalfOf: string;
  onBehalfOfName: string | null;
  permissions: string[];
  /** '*' or a list of account IDs. */
  accountScope: '*' | string[];
}

function pem(b64OrPem: string, label: string): string {
  const raw = b64OrPem.includes('-----BEGIN')
    ? b64OrPem
    : Buffer.from(b64OrPem, 'base64').toString('utf8');
  if (!raw.includes(`-----BEGIN ${label}-----`)) throw new Error(`Expected a ${label} PEM`);
  return raw;
}

export class AgentTokenSigner {
  private constructor(private readonly key: CryptoKey) {}

  static async fromPrivateKey(privateKeyB64: string): Promise<AgentTokenSigner> {
    return new AgentTokenSigner(await importPKCS8(pem(privateKeyB64, 'PRIVATE KEY'), 'EdDSA'));
  }

  async sign(claims: AgentTokenClaims, audience: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      agent_id: claims.agentId,
      agent_name: claims.agentName,
      run_id: claims.runId,
      act: { sub: claims.onBehalfOf, name: claims.onBehalfOfName },
      permissions: claims.permissions,
      account_scope: claims.accountScope,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuer(AGENT_TOKEN_ISSUER)
      .setAudience(audience)
      .setSubject(`agent:${claims.agentId}`)
      .setIssuedAt(now)
      .setExpirationTime(now + AGENT_TOKEN_TTL_SECONDS)
      .setJti(claims.runId)
      .sign(this.key);
  }
}

export class AgentTokenVerifier {
  private constructor(
    private readonly key: CryptoKey,
    private readonly audience: string,
  ) {}

  static async fromPublicKey(publicKeyB64: string, audience: string): Promise<AgentTokenVerifier> {
    return new AgentTokenVerifier(
      await importSPKI(pem(publicKeyB64, 'PUBLIC KEY'), 'EdDSA'),
      audience,
    );
  }

  async verify(token: string): Promise<AgentTokenClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: AGENT_TOKEN_ISSUER,
      audience: this.audience,
      algorithms: ['EdDSA'],
      requiredClaims: ['sub', 'exp', 'iat', 'jti'],
      maxTokenAge: AGENT_TOKEN_TTL_SECONDS + 30,
    });
    const act = payload.act as { sub?: unknown; name?: unknown } | undefined;
    const scope = payload.account_scope;
    if (
      typeof payload.agent_id !== 'string' ||
      typeof payload.run_id !== 'string' ||
      !act ||
      typeof act.sub !== 'string' ||
      !Array.isArray(payload.permissions) ||
      !(scope === '*' || (Array.isArray(scope) && scope.every((s) => typeof s === 'string')))
    ) {
      throw new Error('Malformed agent token');
    }
    return {
      agentId: payload.agent_id,
      agentName: typeof payload.agent_name === 'string' ? payload.agent_name : payload.agent_id,
      runId: payload.run_id,
      onBehalfOf: act.sub,
      onBehalfOfName: typeof act.name === 'string' ? act.name : null,
      permissions: payload.permissions.filter((p): p is string => typeof p === 'string'),
      accountScope: scope as '*' | string[],
    };
  }
}
