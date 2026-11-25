import { startTelemetry, stopTelemetry } from '@astra/platform/telemetry';

startTelemetry('astra-api');

const { createLogger, createPool, FeatureFlags, LocalFileStore, PeopleDirectory, SecretBox } =
  await import('@astra/platform');
const { loadConfig } = await import('./config');
const { Authenticator, parseGroupRoleMap } = await import('./auth/authenticator');
const { buildApp } = await import('./app');
const { KeycloakIssuer } = await import('./accounts/credentials');
const { AgentTokenVerifier } = await import('@astra/agents/agent-token');
const { agentStatusChecker } = await import('./auth/agent-status');

const config = loadConfig();
const logger = createLogger('astra-api', config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
  applicationName: 'astra-api',
});
pool.on('error', (err) => logger.error({ err }, 'Idle database client error'));

const agentVerifier = config.AGENT_TOKEN_PUBLIC_KEY
  ? await AgentTokenVerifier.fromPublicKey(config.AGENT_TOKEN_PUBLIC_KEY, config.OIDC_AUDIENCE)
  : undefined;
if (!agentVerifier) logger.warn('AGENT_TOKEN_PUBLIC_KEY is not set: agent tokens will be refused');

const app = await buildApp({
  config,
  pool,
  logger,
  flags: new FeatureFlags(pool),
  secrets: SecretBox.fromEnv(),
  files: new LocalFileStore(config.FILE_STORE_DIR),
  ...(config.IDP_ADMIN_URL && config.IDP_ADMIN_CLIENT_ID && config.IDP_ADMIN_CLIENT_SECRET
    ? { credentials: new KeycloakIssuer({ url: config.IDP_ADMIN_URL, realm: config.IDP_REALM, adminClientId: config.IDP_ADMIN_CLIENT_ID, adminClientSecret: config.IDP_ADMIN_CLIENT_SECRET, audience: config.OIDC_AUDIENCE, partnerGroup: 'astra-partner-developer' }) }
    : {}),
  people: new PeopleDirectory(pool, logger),
  authenticator: new Authenticator({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    maxTokenLifetimeSeconds: config.OIDC_MAX_TOKEN_LIFETIME_SECONDS,
    groupRoleMap: parseGroupRoleMap(config.OIDC_GROUP_ROLE_MAP),
    agentVerifier,
    isAgentActive: agentStatusChecker(pool),
  }),
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  await app.close();
  await pool.end();
  await stopTelemetry();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
