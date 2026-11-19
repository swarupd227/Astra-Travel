import { startTelemetry, stopTelemetry } from '@astra/platform/telemetry';

startTelemetry('astra-api');

const { createLogger, createPool, FeatureFlags, SecretBox } = await import('@astra/platform');
const { loadConfig } = await import('./config');
const { Authenticator, parseGroupRoleMap } = await import('./auth/authenticator');
const { buildApp } = await import('./app');

const config = loadConfig();
const logger = createLogger('astra-api', config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
  applicationName: 'astra-api',
});
pool.on('error', (err) => logger.error({ err }, 'Idle database client error'));

const app = await buildApp({
  config,
  pool,
  logger,
  flags: new FeatureFlags(pool),
  secrets: SecretBox.fromEnv(),
  authenticator: new Authenticator({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    maxTokenLifetimeSeconds: config.OIDC_MAX_TOKEN_LIFETIME_SECONDS,
    groupRoleMap: parseGroupRoleMap(config.OIDC_GROUP_ROLE_MAP),
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
