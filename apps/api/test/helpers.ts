import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { AgentTokenSigner, AgentTokenVerifier } from '@astra/agents/agent-token';
import { agentStatusChecker } from '../src/auth/agent-status';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLogger,
  createPool,
  FeatureFlags,
  LocalFileStore,
  PeopleDirectory,
  SecretBox,
  type Pool,
} from '@astra/platform';
import { defaultGroupForRole, type Role } from '@astra/contracts';
import { buildApp, type AppDeps } from '../src/app';
import type { CredentialIssuer } from '../src/accounts/credentials';
import { Authenticator } from '../src/auth/authenticator';
import type { ApiConfig } from '../src/config';

export const ISSUER = 'https://idp.test.astra.local/realms/astra';
export const AUDIENCE = 'astra-api';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(`${name} must be set for integration tests (run node scripts/init-env.mjs).`);
  return v;
}

/** A real RSA key pair and JWKS: tokens are genuinely signed and verified, only the issuer is local. */
export async function createTestIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });

  async function token(
    opts: {
      sub?: string;
      roles?: Role[];
      groups?: string[];
      accountId?: string;
      audience?: string;
      issuer?: string;
      lifetimeSeconds?: number;
      name?: string;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      groups: opts.groups ?? (opts.roles ?? []).map(defaultGroupForRole),
      name: opts.name ?? 'Test User',
      email: 'test.user@astra.local',
    };
    if (opts.accountId) claims.account_id = opts.accountId;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(opts.sub ?? `user-${randomUUID()}`)
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.lifetimeSeconds ?? 300))
      .sign(privateKey);
  }

  return { keys, token };
}

export interface TestContext {
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: Pool;
  idp: Awaited<ReturnType<typeof createTestIdp>>;
  /** Signs agent run tokens the test API accepts (a real Ed25519 pair generated per test file). */
  agentSigner: AgentTokenSigner;
  /** The file store the test app writes uploads to (a temporary directory). */
  files: LocalFileStore;
  /** Moves the clock servicing reads (null returns to real time). */
  setNow: (d: Date | null) => void;
  /** Sets (or removes) the identity-provider credential issuer the API uses for sandbox credentials. */
  setCredentials: (issuer: CredentialIssuer | undefined) => void;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Partial<ApiConfig> = {}): Promise<TestContext> {
  const pool = createPool(requireEnv('TEST_DATABASE_URL'), {
    max: 5,
    applicationName: 'astra-api-test',
  });
  const idp = await createTestIdp();
  const agentKeys = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const agentSigner = await AgentTokenSigner.fromPrivateKey(
    Buffer.from(agentKeys.privateKey).toString('base64'),
  );
  const agentVerifier = await AgentTokenVerifier.fromPublicKey(
    Buffer.from(agentKeys.publicKey).toString('base64'),
    AUDIENCE,
  );
  const config: ApiConfig = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
    DATABASE_POOL_MAX: 5,
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_MAX_TOKEN_LIFETIME_SECONDS: 900,
    SECRETS_KEK_ID: 'test',
    SECRETS_KEK: randomBytes(32).toString('base64'),
    RATE_LIMIT_PER_MINUTE: 10_000,
    ALLOW_PRIVATE_WEBHOOK_TARGETS: false,
    ALLOW_ILLUSTRATIVE_RATING: false,
    QUOTE_VALID_DAYS: 30,
    FILE_STORE_DIR: mkdtempSync(join(tmpdir(), 'astra-files-')),
    CARD_FEED_MAX_BYTES: 64 * 1024 * 1024,
    AGENT_SERVICING_MAX_AMOUNT: 500,
    IDP_REALM: 'astra',
    ...overrides,
  };
  const files = new LocalFileStore(config.FILE_STORE_DIR);
  let fixedNow: Date | null = null;
  const deps: AppDeps = {
    config,
    pool,
    // TEST_LOG_LEVEL=error shows server-side errors while debugging a test.
    logger: createLogger(
      'astra-api-test',
      (process.env.TEST_LOG_LEVEL as 'error' | undefined) ?? 'fatal',
    ),
    flags: new FeatureFlags(pool, 0),
    secrets: new SecretBox({ test: config.SECRETS_KEK }, 'test'),
    files,
    now: () => fixedNow ?? new Date(),
    people: new PeopleDirectory(pool, createLogger('astra-people-test', 'fatal'), 0),
    authenticator: new Authenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      maxTokenLifetimeSeconds: config.OIDC_MAX_TOKEN_LIFETIME_SECONDS,
      keys: idp.keys,
      agentVerifier,
      isAgentActive: agentStatusChecker(pool, 0),
    }),
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    pool,
    idp,
    agentSigner,
    files,
    setNow: (d) => {
      fixedNow = d;
    },
    setCredentials: (issuer) => {
      if (issuer) deps.credentials = issuer;
      else delete deps.credentials;
    },
    close: async () => {
      await app.close();
      await pool.end();
      rmSync(config.FILE_STORE_DIR, { recursive: true, force: true });
    },
  };
}

/** Clears mutable tables between tests. The audit trail is append-only and is never cleared. */
export async function resetDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL') });
  await client.connect();
  try {
    // Test databases only: the run log is append-only, so lift its truncate guard inside this transaction.
    await client.query('BEGIN');
    await client.query('ALTER TABLE agents.run_steps DISABLE TRIGGER run_steps_no_truncate');
    await client.query(`TRUNCATE agents.run_steps, agents.reviews, agents.runs, agents.budgets, agents.warrants,
                        agents.eval_runs, agents.eval_sets, agents.agent_versions, agents.agents CASCADE`);
    await client.query('ALTER TABLE agents.run_steps ENABLE TRIGGER run_steps_no_truncate');
    await client.query('COMMIT');
    await client.query(`TRUNCATE platform.event_deliveries, platform.outbox, platform.idempotency_keys,
                        platform.feature_flag_overrides, integration.webhook_subscriptions, card.feed_records, platform.people, platform.accounts CASCADE`);
    await client.query(`TRUNCATE refdata.entries, refdata.versions, compliance.filing_events, compliance.filings,
                        billing.premium_records, billing.batches, billing.commission_rules, billing.programme_rules, documents.delivery_attempts, documents.deliveries, documents.documents, documents.templates, policies.policy_events, policies.policy_benefits, policies.policy_travellers, policies.quotes, policies.policies, underwriting.referrals, underwriting.declarations, underwriting.cover_register, underwriting.test_runs, underwriting.test_cases, underwriting.rule_sets, underwriting.sanctions_entries, underwriting.sanctions_lists, plans.test_runs, plans.test_cases, plans.plan_versions, plans.plans, rating.worksheets, rating.parity_runs, rating.parity_cases, rating.manuals, studio.benefit_catalogues, studio.form_variables, studio.variable_maps, studio.form_editions CASCADE`);
    await client.query(`UPDATE platform.feature_flags SET enabled = true`);
  } finally {
    await client.end();
  }
}

/** Inserts an account directly (as the platform), returning its ID. */
export async function insertAccount(
  pool: Pool,
  code: string,
  kind = 'travel_account',
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.account_ids', '*', true)`);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO platform.accounts (code, name, kind, created_by) VALUES ($1, $2, $3, 'test') RETURNING id`,
      [code, `${code} (synthetic)`, kind],
    );
    await client.query('COMMIT');
    return rows[0]!.id;
  } finally {
    client.release();
  }
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
