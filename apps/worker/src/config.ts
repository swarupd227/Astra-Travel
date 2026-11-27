import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  SECRETS_KEK_ID: z.string().min(1),
  SECRETS_KEK: z.string().min(1),
  ALLOW_PRIVATE_WEBHOOK_TARGETS: bool,
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  AUDIT_SEAL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** How often changes are loaded to the data platform; they must land within 15 minutes (E12-F01-S02). */
  DATA_LOAD_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(300_000),
  AUDIT_SEAL_MIN_AGE_SECONDS: z.coerce.number().int().min(70).default(120),
  /** Base64 PKCS#8 PEM of the Ed25519 key that signs agent run tokens. Agents do not run without it. */
  AGENT_TOKEN_PRIVATE_KEY: z.string().optional(),
  /** Where agent tools call the platform API, and the audience their tokens are issued for. */
  API_BASE_URL: z.url().default('http://localhost:4000'),
  OIDC_AUDIENCE: z.string().min(1).default('astra-api'),
  AGENT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** Where uploaded files (eligibility feeds) are kept; must be the API's FILE_STORE_DIR. */
  FILE_STORE_DIR: z.string().default('../../var/files'),
  /** Mail server for emailing documents, as smtp://user:password@host:587. Without it email deliveries fail with that reason. */
  SMTP_URL: z.string().optional(),
  /** The sender address of emailed documents; required with SMTP_URL. */
  MAIL_FROM: z.string().optional(),
  /** Where billing batches are dropped as files, or the URL they are pushed to (signed with BILLING_SIGNING_SECRET). Neither set: batches wait. */
  BILLING_DROP_DIR: z.string().optional(),
  BILLING_URL: z.url().optional(),
  BILLING_SIGNING_SECRET: z.string().min(16).optional(),
  /** How long to wait for billing's confirmation of a batch before sending it again. */
  BILLING_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(900_000),
  BILLING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker configuration: ${issues}`);
  }
  if (parsed.data.BILLING_URL && !parsed.data.BILLING_SIGNING_SECRET)
    throw new Error(
      'Invalid worker configuration: BILLING_SIGNING_SECRET is required with BILLING_URL.',
    );
  if (parsed.data.SMTP_URL && !parsed.data.MAIL_FROM)
    throw new Error('Invalid worker configuration: MAIL_FROM is required with SMTP_URL.');
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ALLOW_PRIVATE_WEBHOOK_TARGETS) {
    throw new Error('ALLOW_PRIVATE_WEBHOOK_TARGETS must not be enabled in production.');
  }
  return parsed.data;
}
