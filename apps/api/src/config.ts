import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  OIDC_ISSUER: z.url(),
  OIDC_AUDIENCE: z.string().min(1),
  /** JSON object mapping IdP group names or object IDs to Astra roles. */
  OIDC_GROUP_ROLE_MAP: z.string().optional(),
  /** Tokens that live longer than this are refused, so removed users lose access within it. */
  OIDC_MAX_TOKEN_LIFETIME_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  SECRETS_KEK_ID: z.string().min(1),
  SECRETS_KEK: z.string().min(1),
  CORS_ORIGINS: z.string().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(600),
  /** Local development only: lets webhooks target http:// and private addresses. */
  ALLOW_PRIVATE_WEBHOOK_TARGETS: bool,
  /** Base64 SPKI PEM of the agent runtime's Ed25519 signing key. Without it, agent tokens are refused. */
  AGENT_TOKEN_PUBLIC_KEY: z.string().optional(),
  /** Where uploaded files (eligibility feeds) are kept. Azure uses Blob Storage instead. */
  FILE_STORE_DIR: z.string().default('../../var/files'),
  /** Demonstration and sandbox only: allows illustrative manuals (estimated loadings), always labelled. */
  ALLOW_ILLUSTRATIVE_RATING: bool,
  /** How long a quote stays open for bind (days). Assurant confirms the period. */
  QUOTE_VALID_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** The largest charge or refund the servicing agent may confirm on its own; above it the request goes to a person. To be confirmed by Assurant. */
  AGENT_SERVICING_MAX_AMOUNT: z.coerce.number().min(0).max(100000).default(500),
  /** Largest eligibility feed accepted, in bytes (default 4 GiB: about 50 million records). */
  CARD_FEED_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(4 * 1024 ** 3),
});

export type ApiConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid API configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ALLOW_PRIVATE_WEBHOOK_TARGETS) {
    throw new Error('ALLOW_PRIVATE_WEBHOOK_TARGETS must not be enabled in production.');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ALLOW_ILLUSTRATIVE_RATING) {
    throw new Error(
      'ALLOW_ILLUSTRATIVE_RATING must not be enabled in production: unfiled prices are never charged.',
    );
  }
  return parsed.data;
}
