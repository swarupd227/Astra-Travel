import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OIDC_ISSUER: z.url(),
  WORKBENCH_CLIENT_ID: z.string().min(1),
  WORKBENCH_CLIENT_SECRET: z.string().min(1),
  WORKBENCH_BASE_URL: z.url(),
  WORKBENCH_SESSION_SECRET: z
    .string()
    .min(32, 'WORKBENCH_SESSION_SECRET must be at least 32 characters'),
  API_BASE_URL: z.url(),
  /** Signs the short tokens the hosted journey uses to quote and buy; the same secret as the API's. The journey is off without it. */
  CHANNEL_SIGNING_SECRET: z.string().min(32).optional(),
});

export type WorkbenchEnv = z.infer<typeof EnvSchema>;

let cached: WorkbenchEnv | undefined;

/** Server-side configuration. Read lazily so `next build` does not need runtime secrets. */
export function env(): WorkbenchEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid workbench configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
