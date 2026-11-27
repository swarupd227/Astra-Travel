/**
 * The platform's own API, run inside the sample data loader without opening a port. Every record is created through
 * the same routes, permissions, maker-checker rules and database constraints as in use. The loader signs its own
 * short tokens for synthetic people; nothing outside this process accepts them.
 */
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { defaultGroupForRole, type Role } from '@astra/contracts';
import {
  createLogger,
  createPool,
  FeatureFlags,
  LocalFileStore,
  PeopleDirectory,
  SecretBox,
  type Pool,
} from '@astra/platform';
import { buildApp } from '../app';
import { Authenticator } from '../auth/authenticator';
import { loadConfig } from '../config';

const ISSUER = 'https://sample-data.astra.invalid';
const AUDIENCE = 'astra-api';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
// The loader reads only a few fields of each answer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Actor {
  sub: string;
  role: Role;
  name: string;
  accountId?: string;
}

export interface Client {
  pool: Pool;
  files: LocalFileStore;
  call: (
    actor: Actor,
    method: Method,
    url: string,
    body?: unknown,
    options?: { contentType?: string; allow?: number[] },
  ) => Promise<Json>;
  close: () => Promise<void>;
}

export async function startClient(env: NodeJS.ProcessEnv): Promise<Client> {
  const config = loadConfig({
    ...env,
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    RATE_LIMIT_PER_MINUTE: '100000000',
    LOG_LEVEL: 'fatal',
  });
  const pool = createPool(config.DATABASE_URL, {
    max: 12,
    applicationName: 'astra-sample-data',
    connectionTimeoutMillis: 60_000,
  });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'sample', alg: 'RS256', use: 'sig' };
  const logger = createLogger('astra-sample-data', 'fatal');
  const files = new LocalFileStore(config.FILE_STORE_DIR);
  const app = await buildApp({
    config,
    pool,
    logger,
    files,
    flags: new FeatureFlags(pool),
    secrets: SecretBox.fromEnv(env),
    people: new PeopleDirectory(pool, logger),
    authenticator: new Authenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      maxTokenLifetimeSeconds: config.OIDC_MAX_TOKEN_LIFETIME_SECONDS,
      keys: createLocalJWKSet({ keys: [jwk] }),
    }),
  });
  await app.ready();

  const tokens = new Map<string, { value: string; until: number }>();
  async function token(actor: Actor): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const held = tokens.get(actor.sub);
    if (held && held.until > now + 60) return held.value;
    const value = await new SignJWT({
      groups: [defaultGroupForRole(actor.role)],
      name: actor.name,
      ...(actor.accountId ? { account_id: actor.accountId } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'sample' })
      .setSubject(actor.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(privateKey);
    tokens.set(actor.sub, { value, until: now + 600 });
    return value;
  }

  return {
    pool,
    files,
    async call(actor, method, url, body, options = {}) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await token(actor)}`,
        'idempotency-key': `sample-${randomUUID()}`,
      };
      if (options.contentType) headers['content-type'] = options.contentType;
      const res = await app.inject({
        method,
        url,
        headers,
        ...(body === undefined ? {} : { payload: body as object }),
      });
      if (res.statusCode >= 400 && !options.allow?.includes(res.statusCode)) {
        throw new ApiError(
          res.statusCode,
          `${method} ${url} answered ${res.statusCode}: ${res.body}`,
        );
      }
      const type = String(res.headers['content-type'] ?? '');
      return type.includes('json') ? res.json() : res.body;
    },
    async close() {
      await app.close();
      await pool.end();
    },
  };
}
