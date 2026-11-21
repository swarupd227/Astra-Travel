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
  AUDIT_SEAL_MIN_AGE_SECONDS: z.coerce.number().int().min(70).default(120),
  /** Base64 PKCS#8 PEM of the Ed25519 key that signs agent run tokens. Agents do not run without it. */
  AGENT_TOKEN_PRIVATE_KEY: z.string().optional(),
  /** Where agent tools call the platform API, and the audience their tokens are issued for. */
  API_BASE_URL: z.url().default('http://localhost:4000'),
  OIDC_AUDIENCE: z.string().min(1).default('astra-api'),
  AGENT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** Where uploaded files (eligibility feeds) are kept; must be the API's FILE_STORE_DIR. */
  FILE_STORE_DIR: z.string().default('../../var/files'),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ALLOW_PRIVATE_WEBHOOK_TARGETS) {
    throw new Error('ALLOW_PRIVATE_WEBHOOK_TARGETS must not be enabled in production.');
  }
  return parsed.data;
}
