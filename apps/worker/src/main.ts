import { startTelemetry, stopTelemetry } from '@astra/platform/telemetry';

startTelemetry('astra-worker');

const { createServer } = await import('node:http');
const pg = (await import('pg')).default;
const platform = await import('@astra/platform');
const { loadConfig } = await import('./config');
const { webhookSource } = await import('./webhooks');
const { Loop } = await import('./loops');
const { startAgentLoops } = await import('./agents');
const { cardFeedLoop } = await import('./card-feeds');
const { documentDeliveryLoop } = await import('./documents');
const { billingSendLoop } = await import('./billing');
const { licenceAlertLoop } = await import('./licences');

const {
  CompositeRegistry,
  createLogger,
  createPool,
  dispatchDue,
  FeatureFlags,
  LocalFileStore,
  purgeExpiredIdempotencyKeys,
  relayOutbox,
  sealAudit,
  SecretBox,
  runDataLoad,
  systemContext,
  withTx,
  platformMetrics,
} = platform;

const config = loadConfig();
const logger = createLogger('astra-worker', config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, {
  max: config.WORKER_CONCURRENCY + 4,
  applicationName: 'astra-worker',
});
pool.on('error', (err) => logger.error({ err }, 'Idle database client error'));

const flags = new FeatureFlags(pool);
const registry = new CompositeRegistry(
  [],
  [
    webhookSource({
      pool,
      flags,
      logger,
      secrets: SecretBox.fromEnv(),
      policy: { allowPrivate: config.ALLOW_PRIVATE_WEBHOOK_TARGETS },
    }),
  ],
);

const RELAY_BATCH = 200;
const DISPATCH_BATCH = 50;

const relay = new Loop(
  'relay',
  config.WORKER_POLL_MS,
  async () => {
    const n = await relayOutbox(pool, registry, RELAY_BATCH);
    if (n > 0) dispatch.wake();
    return n === RELAY_BATCH;
  },
  logger,
);

const dispatch = new Loop(
  'dispatch',
  config.WORKER_POLL_MS,
  async () => {
    const n = await dispatchDue(pool, registry, {
      batchSize: DISPATCH_BATCH,
      concurrency: config.WORKER_CONCURRENCY,
      logger,
    });
    return n === DISPATCH_BATCH;
  },
  logger,
);

const sealer = new Loop(
  'audit-seal',
  config.AUDIT_SEAL_INTERVAL_MS,
  async () => {
    const sealId = await withTx(pool, systemContext('audit-sealer'), (tx) =>
      sealAudit(tx, config.AUDIT_SEAL_MIN_AGE_SECONDS),
    );
    if (sealId) {
      platformMetrics().auditSeals.add(1);
      logger.info({ sealId }, 'Audit records sealed');
    }
    return false;
  },
  logger,
);

const housekeeping = new Loop(
  'housekeeping',
  3_600_000,
  async () => {
    const purged = await withTx(pool, systemContext('housekeeping'), purgeExpiredIdempotencyKeys);
    if (purged) logger.info({ purged }, 'Expired idempotency keys purged');
    return purged === 10_000;
  },
  logger,
);

// LISTEN/NOTIFY wakes the relay as soon as an event commits; polling is the fallback.
const listener = new pg.Client({
  connectionString: config.DATABASE_URL,
  application_name: 'astra-worker-listen',
});
async function listen() {
  try {
    await listener.connect();
    listener.on('notification', () => relay.wake());
    listener.on('error', (err) =>
      logger.warn({ err }, 'Outbox listener error; relying on polling'),
    );
    await listener.query('LISTEN astra_outbox');
  } catch (err) {
    logger.warn({ err }, 'Could not LISTEN for outbox notifications; relying on polling');
  }
}
await listen();

const agentLoops = await startAgentLoops(pool, config, logger, SecretBox.fromEnv());
const cardFeeds = cardFeedLoop(pool, config, logger);
// A new feed is announced through the outbox, so the same notification wakes feed processing.
listener.on('notification', () => cardFeeds.wake());
const documentDelivery = documentDeliveryLoop(
  pool,
  new LocalFileStore(config.FILE_STORE_DIR),
  config,
  logger,
);
listener.on('notification', () => documentDelivery.wake());
const billingSend = billingSendLoop(
  pool,
  new LocalFileStore(config.FILE_STORE_DIR),
  config,
  logger,
);
const licenceAlerts = licenceAlertLoop(pool, config, logger);
const loadStore = new LocalFileStore(config.FILE_STORE_DIR);
const dataLoad = new Loop(
  'data-load',
  config.DATA_LOAD_INTERVAL_MS,
  async () => {
    const r = await runDataLoad(pool, systemContext('data-load'), loadStore, {
      trigger: 'schedule',
    });
    if (r)
      logger.info(
        {
          load: r.load.number,
          items: r.load.items,
          rejected: r.load.rejected,
          maxLagSeconds: r.load.maxLagSeconds,
        },
        'Changes loaded for the data platform',
      );
    return r?.more ?? false;
  },
  logger,
);
const loops = [
  relay,
  dispatch,
  sealer,
  housekeeping,
  cardFeeds,
  documentDelivery,
  billingSend,
  licenceAlerts,
  dataLoad,
  ...agentLoops,
];
for (const loop of loops) loop.start();

const health = createServer((req, res) => {
  if (req.url === '/health/live') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (req.url === '/health/ready') {
    pool
      .query('SELECT 1')
      .then(() =>
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ready"}'),
      )
      .catch(() =>
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"unavailable"}'),
      );
    return;
  }
  res.writeHead(404).end();
});
health.listen(config.WORKER_HEALTH_PORT);
logger.info({ healthPort: config.WORKER_HEALTH_PORT }, 'Worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down; finishing in-flight work');
  await Promise.all(loops.map((l) => l.stop()));
  health.close();
  await listener.end().catch(() => undefined);
  await pool.end();
  await stopTelemetry();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
